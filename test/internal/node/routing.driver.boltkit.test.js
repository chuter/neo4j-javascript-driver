/**
 * Copyright (c) 2002-2019 "Neo4j,"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import neo4j from '../../../src'
import { READ, WRITE } from '../../../src/driver'
import boltStub from '../bolt-stub'
import RoutingTable from '../../../src/internal/routing-table'
import { SERVICE_UNAVAILABLE, SESSION_EXPIRED } from '../../../src/error'
import lolex from 'lolex'
import ServerAddress from '../../../src/internal/server-address'

describe('#stub-routing routing driver with stub server', () => {
  let originalTimeout

  beforeAll(() => {
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000
  })

  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout
  })

  it('should discover servers', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const server = boltStub.start(
      './test/resources/boltstub/v3/discover_servers_and_read.script',
      9001
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session()
      session.run('MATCH (n) RETURN n.name').then(() => {
        session.close()
        // Then
        expect(
          hasAddressInConnectionPool(driver, '127.0.0.1:9001')
        ).toBeTruthy()
        assertHasRouters(driver, [
          '127.0.0.1:9001',
          '127.0.0.1:9002',
          '127.0.0.1:9003'
        ])
        assertHasReaders(driver, ['127.0.0.1:9002', '127.0.0.1:9003'])
        assertHasWriters(driver, ['127.0.0.1:9001'])

        driver.close()
        server.exit(code => {
          expect(code).toEqual(0)
          done()
        })
      })
    })
  })

  it('should discover IPv6 servers', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const server = boltStub.start(
      './test/resources/boltstub/v3/discover_ipv6_servers_and_read.script',
      9001
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      const session = driver.session({ defaultAccessMode: READ })
      session.run('MATCH (n) RETURN n.name').then(() => {
        expect(
          hasAddressInConnectionPool(driver, '127.0.0.1:9001')
        ).toBeTruthy()
        assertHasReaders(driver, ['127.0.0.1:9001', '[::1]:9001'])
        assertHasWriters(driver, [
          '[2001:db8:a0b:12f0::1]:9002',
          '[3731:54:65fe:2::a7]:9003'
        ])
        assertHasRouters(driver, [
          '[ff02::1]:9001',
          '[684d:1111:222:3333:4444:5555:6:77]:9002',
          '[::1]:9003'
        ])

        expect(
          hasAddressInConnectionPool(driver, '127.0.0.1:9001')
        ).toBeTruthy()
        assertHasReaders(driver, ['127.0.0.1:9001', '[::1]:9001'])
        assertHasWriters(driver, [
          '[2001:db8:a0b:12f0::1]:9002',
          '[3731:54:65fe:2::a7]:9003'
        ])
        assertHasRouters(driver, [
          '[ff02::1]:9001',
          '[684d:1111:222:3333:4444:5555:6:77]:9002',
          '[::1]:9003'
        ])

        driver.close()
        server.exit(code => {
          expect(code).toEqual(0)
          done()
        })
      })
    })
  })

  it('should purge connections to stale servers after routing table refresh', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9042
    )
    const reader = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9042')
      const session = driver.session({ defaultAccessMode: READ })
      session.run('MATCH (n) RETURN n.name').then(() => {
        session.close()

        expect(hasAddressInConnectionPool(driver, '127.0.0.1:9042')).toBeFalsy()
        expect(
          hasAddressInConnectionPool(driver, '127.0.0.1:9005')
        ).toBeTruthy()

        driver.close()
        router.exit(routerCode => {
          reader.exit(readerCode => {
            expect(routerCode).toEqual(0)
            expect(readerCode).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should discover servers using subscribe', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const server = boltStub.start(
      './test/resources/boltstub/v3/discover_servers_and_read.script',
      9001
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session()
      session.run('MATCH (n) RETURN n.name').subscribe({
        onCompleted: () => {
          // Then
          assertHasRouters(driver, [
            '127.0.0.1:9001',
            '127.0.0.1:9002',
            '127.0.0.1:9003'
          ])
          assertHasReaders(driver, ['127.0.0.1:9002', '127.0.0.1:9003'])
          assertHasWriters(driver, ['127.0.0.1:9001'])

          driver.close()
          server.exit(code => {
            expect(code).toEqual(0)
            done()
          })
        }
      })
    })
  })

  it('should handle empty response from server', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const server = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_no_records.script',
      9001
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')

      // When
      const session = driver.session({ defaultAccessMode: neo4j.READ })
      session
        .run('MATCH (n) RETURN n.name')
        .catch(err => {
          expect(err.code).toEqual(neo4j.error.SERVICE_UNAVAILABLE)

          session.close()
          driver.close()
          server.exit(code => {
            expect(code).toEqual(0)
            done()
          })
        })
        .catch(err => {
          console.log(err)
        })
    })
  })

  it('should acquire read server', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const readServer = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session({ defaultAccessMode: READ })
      session.run('MATCH (n) RETURN n.name').then(res => {
        session.close()

        expect(
          hasAddressInConnectionPool(driver, '127.0.0.1:9001')
        ).toBeTruthy()
        expect(
          hasAddressInConnectionPool(driver, '127.0.0.1:9005')
        ).toBeTruthy()
        // Then
        expect(res.records[0].get('n.name')).toEqual('Bob')
        expect(res.records[1].get('n.name')).toEqual('Alice')
        expect(res.records[2].get('n.name')).toEqual('Tina')
        driver.close()
        seedServer.exit(code1 => {
          readServer.exit(code2 => {
            expect(code1).toEqual(0)
            expect(code2).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should pick first available route-server', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_short_ttl.script',
      9999
    )
    const nextRouter = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9003
    )
    const readServer1 = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9004
    )
    const readServer2 = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9006
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9999')
      // When
      const session1 = driver.session({ defaultAccessMode: READ })
      session1.run('MATCH (n) RETURN n.name').then(res => {
        // Then
        expect(res.records[0].get('n.name')).toEqual('Bob')
        expect(res.records[1].get('n.name')).toEqual('Alice')
        expect(res.records[2].get('n.name')).toEqual('Tina')
        session1.close()

        const session2 = driver.session({ defaultAccessMode: READ })
        session2.run('MATCH (n) RETURN n.name').then(res => {
          // Then
          expect(res.records[0].get('n.name')).toEqual('Bob')
          expect(res.records[1].get('n.name')).toEqual('Alice')
          expect(res.records[2].get('n.name')).toEqual('Tina')
          session2.close()
          driver.close()
          seedServer.exit(code1 => {
            nextRouter.exit(code2 => {
              readServer1.exit(code3 => {
                readServer2.exit(code4 => {
                  expect(code1).toEqual(0)
                  expect(code2).toEqual(0)
                  expect(code3).toEqual(0)
                  expect(code4).toEqual(0)
                  done()
                })
              })
            })
          })
        })
      })
    })
  })

  it('should round-robin among read servers', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const readServer1 = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9005
    )
    const readServer2 = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9006
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session1 = driver.session({ defaultAccessMode: READ })
      session1.run('MATCH (n) RETURN n.name').then(res => {
        // Then
        expect(res.records[0].get('n.name')).toEqual('Bob')
        expect(res.records[1].get('n.name')).toEqual('Alice')
        expect(res.records[2].get('n.name')).toEqual('Tina')
        session1.close()
        const session2 = driver.session({ defaultAccessMode: READ })
        session2.run('MATCH (n) RETURN n.name').then(res => {
          // Then
          expect(res.records[0].get('n.name')).toEqual('Bob')
          expect(res.records[1].get('n.name')).toEqual('Alice')
          expect(res.records[2].get('n.name')).toEqual('Tina')
          session2.close()

          driver.close()
          seedServer.exit(code1 => {
            readServer1.exit(code2 => {
              readServer2.exit(code3 => {
                expect(code1).toEqual(0)
                expect(code2).toEqual(0)
                expect(code3).toEqual(0)
                done()
              })
            })
          })
        })
      })
    })
  })

  it('should handle missing read server', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const readServer = boltStub.start(
      './test/resources/boltstub/v3/read_dead.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session({ defaultAccessMode: READ })
      session.run('MATCH (n) RETURN n.name').catch(err => {
        expect(err.code).toEqual(neo4j.error.SESSION_EXPIRED)
        driver.close()
        seedServer.exit(code1 => {
          readServer.exit(code2 => {
            expect(code1).toEqual(0)
            expect(code2).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should acquire write server', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const writeServer = boltStub.start(
      './test/resources/boltstub/v3/write.script',
      9007
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session({ defaultAccessMode: WRITE })
      session.run("CREATE (n {name:'Bob'})").then(() => {
        // Then
        driver.close()
        seedServer.exit(code1 => {
          writeServer.exit(code2 => {
            expect(code1).toEqual(0)
            expect(code2).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should round-robin among write servers', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const readServer1 = boltStub.start(
      './test/resources/boltstub/v3/write.script',
      9007
    )
    const readServer2 = boltStub.start(
      './test/resources/boltstub/v3/write.script',
      9008
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session1 = driver.session({ defaultAccessMode: WRITE })
      session1.run("CREATE (n {name:'Bob'})").then(() => {
        const session2 = driver.session({ defaultAccessMode: WRITE })
        session2.run("CREATE (n {name:'Bob'})").then(() => {
          // Then
          driver.close()
          seedServer.exit(code1 => {
            readServer1.exit(code2 => {
              readServer2.exit(code3 => {
                expect(code1).toEqual(0)
                expect(code2).toEqual(0)
                expect(code3).toEqual(0)
                done()
              })
            })
          })
        })
      })
    })
  })

  it('should handle missing write server', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const readServer = boltStub.start(
      './test/resources/boltstub/v3/write_dead.script',
      9007
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session({ defaultAccessMode: WRITE })
      session.run('CREATE ()').catch(err => {
        expect(err.code).toEqual(neo4j.error.SESSION_EXPIRED)
        driver.close()
        seedServer.exit(code1 => {
          readServer.exit(code2 => {
            expect(code1).toEqual(0)
            expect(code2).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should remember endpoints', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const readServer = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session({ defaultAccessMode: READ })
      session.run('MATCH (n) RETURN n.name').then(() => {
        // Then
        assertHasRouters(driver, [
          '127.0.0.1:9001',
          '127.0.0.1:9002',
          '127.0.0.1:9003'
        ])
        assertHasReaders(driver, ['127.0.0.1:9005', '127.0.0.1:9006'])
        assertHasWriters(driver, ['127.0.0.1:9007', '127.0.0.1:9008'])
        driver.close()
        seedServer.exit(code1 => {
          readServer.exit(code2 => {
            expect(code1).toEqual(0)
            expect(code2).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should forget endpoints on failure', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const readServer = boltStub.start(
      './test/resources/boltstub/v3/read_dead.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session({ defaultAccessMode: READ })
      session.run('MATCH (n) RETURN n.name').catch(() => {
        session.close()
        // Then
        expect(
          hasAddressInConnectionPool(driver, '127.0.0.1:9001')
        ).toBeTruthy()
        expect(hasAddressInConnectionPool(driver, '127.0.0.1:9005')).toBeFalsy()
        assertHasRouters(driver, [
          '127.0.0.1:9001',
          '127.0.0.1:9002',
          '127.0.0.1:9003'
        ])
        assertHasReaders(driver, ['127.0.0.1:9006'])
        assertHasWriters(driver, ['127.0.0.1:9007', '127.0.0.1:9008'])
        driver.close()
        seedServer.exit(code1 => {
          readServer.exit(code2 => {
            expect(code1).toEqual(0)
            expect(code2).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should forget endpoints on session acquisition failure', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session({ defaultAccessMode: READ })
      session.run('MATCH (n) RETURN n.name').catch(() => {
        session.close()
        // Then
        expect(
          hasAddressInConnectionPool(driver, '127.0.0.1:9001')
        ).toBeTruthy()
        expect(hasAddressInConnectionPool(driver, '127.0.0.1:9005')).toBeFalsy()
        assertHasRouters(driver, [
          '127.0.0.1:9001',
          '127.0.0.1:9002',
          '127.0.0.1:9003'
        ])
        assertHasReaders(driver, ['127.0.0.1:9006'])
        assertHasWriters(driver, ['127.0.0.1:9007', '127.0.0.1:9008'])
        driver.close()
        seedServer.exit(code => {
          expect(code).toEqual(0)
          done()
        })
      })
    })
  })

  it('should rediscover if necessary', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_rediscover.script',
      9001
    )
    const readServer = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session1 = driver.session({ defaultAccessMode: READ })
      session1.run('MATCH (n) RETURN n.name').catch(() => {
        const session2 = driver.session({ defaultAccessMode: READ })
        session2.run('MATCH (n) RETURN n.name').then(() => {
          driver.close()
          seedServer.exit(code1 => {
            readServer.exit(code2 => {
              expect(code1).toEqual(0)
              expect(code2).toEqual(0)
              done()
            })
          })
        })
      })
    })
  })

  it('should handle server not able to do routing', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    // Given
    const server = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_not_supported.script',
      9001
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session()
      session.run('MATCH (n) RETURN n.name').catch(err => {
        expect(err.code).toEqual(neo4j.error.SERVICE_UNAVAILABLE)
        expect(err.message).toContain('Could not perform discovery')
        assertNoRoutingTable(driver)
        session.close()
        driver.close()
        server.exit(code => {
          expect(code).toEqual(0)
          done()
        })
      })
    })
  })

  it('should handle leader switch while writing', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const readServer = boltStub.start(
      './test/resources/boltstub/v3/write_not_a_leader.script',
      9007
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session()
      session.run('CREATE ()').catch(err => {
        // the server at 9007 should have been removed
        assertHasWriters(driver, ['127.0.0.1:9008'])
        expect(err.code).toEqual(neo4j.error.SESSION_EXPIRED)
        session.close()
        driver.close()
        seedServer.exit(code1 => {
          readServer.exit(code2 => {
            expect(code1).toEqual(0)
            expect(code2).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should handle leader switch while writing on transaction', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const readServer = boltStub.start(
      './test/resources/boltstub/v3/write_tx_not_a_leader.script',
      9007
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session()
      const tx = session.beginTransaction()
      tx.run('CREATE ()')

      tx.commit().catch(err => {
        // the server at 9007 should have been removed
        assertHasWriters(driver, ['127.0.0.1:9008'])
        expect(err.code).toEqual(neo4j.error.SESSION_EXPIRED)
        session.close()
        driver.close()
        seedServer.exit(code1 => {
          readServer.exit(code2 => {
            expect(code1).toEqual(0)
            expect(code2).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should fail if missing write server', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_no_writers.script',
      9001
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session({ defaultAccessMode: WRITE })
      session.run('MATCH (n) RETURN n.name').catch(err => {
        expect(err.code).toEqual(neo4j.error.SESSION_EXPIRED)
        driver.close()
        seedServer.exit(code => {
          expect(code).toEqual(0)
          done()
        })
      })
    })
  })

  it('should try next router when current router fails to return a routing table', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const server1 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_zero_ttl.script',
      9999
    )
    const server2 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_dead.script',
      9091
    )
    const server3 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_dead.script',
      9092
    )
    const server4 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_dead.script',
      9093
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9999')

      const session1 = driver.session()
      session1.run('MATCH (n) RETURN n').then(result1 => {
        expect(result1.summary.server.address).toEqual('127.0.0.1:9999')
        session1.close()

        assertHasRouters(driver, [
          '127.0.0.1:9091',
          '127.0.0.1:9092',
          '127.0.0.1:9093',
          '127.0.0.1:9999'
        ])
        const memorizingRoutingTable = setUpMemorizingRoutingTable(driver)

        const session2 = driver.session()
        session2.run('MATCH (n) RETURN n').then(result2 => {
          expect(result2.summary.server.address).toEqual('127.0.0.1:9999')
          session2.close()

          // returned routers failed to respond and should have been forgotten
          memorizingRoutingTable.assertForgotRouters([
            '127.0.0.1:9091',
            '127.0.0.1:9092',
            '127.0.0.1:9093'
          ])
          assertHasRouters(driver, ['127.0.0.1:9999'])
          driver.close()

          server1.exit(code1 => {
            server2.exit(code2 => {
              server3.exit(code3 => {
                server4.exit(code4 => {
                  expect(code1).toEqual(0)
                  expect(code2).toEqual(0)
                  expect(code3).toEqual(0)
                  expect(code4).toEqual(0)
                  done()
                })
              })
            })
          })
        })
      })
    })
  })

  it('should re-use connections', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_three_servers_set_1.script',
      9002
    )
    const writeServer = boltStub.start(
      './test/resources/boltstub/v3/write_twice.script',
      9001
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9002')
      // When
      const session1 = driver.session({ defaultAccessMode: WRITE })
      session1.run("CREATE (n {name:'Bob'})").then(() => {
        session1.close(() => {
          const openConnectionsCount = numberOfOpenConnections(driver)
          const session2 = driver.session({ defaultAccessMode: WRITE })
          session2.run('CREATE ()').then(() => {
            // driver should have same amount of open connections at this point;
            // no new connections should be created, existing connections should be reused
            expect(numberOfOpenConnections(driver)).toEqual(
              openConnectionsCount
            )
            driver.close()

            // all connections should be closed when driver is closed
            expect(numberOfOpenConnections(driver)).toEqual(0)

            seedServer.exit(code1 => {
              writeServer.exit(code2 => {
                expect(code1).toEqual(0)
                expect(code2).toEqual(0)
                done()
              })
            })
          })
        })
      })
    })
  })

  it('should expose server info in cluster', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    // Given
    const routingServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const writeServer = boltStub.start(
      './test/resources/boltstub/v3/write_with_server_version.script',
      9007
    )
    const readServer = boltStub.start(
      './test/resources/boltstub/v3/read_with_server_version.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const readSession = driver.session({ defaultAccessMode: READ })
      readSession.run('MATCH (n) RETURN n.name').then(readResult => {
        const writeSession = driver.session({ defaultAccessMode: WRITE })
        writeSession.run("CREATE (n {name:'Bob'})").then(writeResult => {
          const readServerInfo = readResult.summary.server
          const writeServerInfo = writeResult.summary.server

          readSession.close()
          writeSession.close()
          driver.close()

          routingServer.exit(routingServerExitCode => {
            writeServer.exit(writeServerExitCode => {
              readServer.exit(readServerExitCode => {
                expect(readServerInfo.address).toBe('127.0.0.1:9005')
                expect(readServerInfo.version).toBe('Neo4j/8.8.8')

                expect(writeServerInfo.address).toBe('127.0.0.1:9007')
                expect(writeServerInfo.version).toBe('Neo4j/9.9.9')

                expect(routingServerExitCode).toEqual(0)
                expect(writeServerExitCode).toEqual(0)
                expect(readServerExitCode).toEqual(0)

                done()
              })
            })
          })
        })
      })
    })
  })

  it('should expose server info in cluster using observer', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    // Given
    const routingServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const writeServer = boltStub.start(
      './test/resources/boltstub/v3/write_with_server_version.script',
      9007
    )
    const readServer = boltStub.start(
      './test/resources/boltstub/v3/read_with_server_version.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const readSession = driver.session({ defaultAccessMode: READ })
      readSession.run('MATCH (n) RETURN n.name').subscribe({
        onNext: () => {},
        onError: () => {},
        onCompleted: readSummary => {
          const writeSession = driver.session({ defaultAccessMode: WRITE })
          writeSession.run("CREATE (n {name:'Bob'})").subscribe({
            onNext: () => {},
            onError: () => {},
            onCompleted: writeSummary => {
              readSession.close()
              writeSession.close()
              driver.close()

              routingServer.exit(routingServerExitCode => {
                writeServer.exit(writeServerExitCode => {
                  readServer.exit(readServerExitCode => {
                    expect(readSummary.server.address).toBe('127.0.0.1:9005')
                    expect(readSummary.server.version).toBe('Neo4j/8.8.8')

                    expect(writeSummary.server.address).toBe('127.0.0.1:9007')
                    expect(writeSummary.server.version).toBe('Neo4j/9.9.9')

                    expect(routingServerExitCode).toEqual(0)
                    expect(writeServerExitCode).toEqual(0)
                    expect(readServerExitCode).toEqual(0)

                    done()
                  })
                })
              })
            }
          })
        }
      })
    })
  })

  it('should forget routers when fails to connect', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const server = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_zero_ttl.script',
      9999
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9999')

      const session1 = driver.session()
      session1.run('MATCH (n) RETURN n').then(result1 => {
        expect(result1.summary.server.address).toEqual('127.0.0.1:9999')
        session1.close()

        assertHasRouters(driver, [
          '127.0.0.1:9091',
          '127.0.0.1:9092',
          '127.0.0.1:9093',
          '127.0.0.1:9999'
        ])
        const memorizingRoutingTable = setUpMemorizingRoutingTable(driver)

        const session2 = driver.session()
        session2.run('MATCH (n) RETURN n').then(result2 => {
          expect(result2.summary.server.address).toEqual('127.0.0.1:9999')
          session2.close()

          memorizingRoutingTable.assertForgotRouters([
            '127.0.0.1:9091',
            '127.0.0.1:9092',
            '127.0.0.1:9093'
          ])
          assertHasRouters(driver, ['127.0.0.1:9999'])
          driver.close()

          server.exit(code1 => {
            expect(code1).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should close connection used for routing table refreshing', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    // server is both router and writer
    const server = boltStub.start(
      './test/resources/boltstub/v3/discover_servers_and_read.script',
      9001
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')

      const acquiredConnections = []
      const releasedConnections = []
      setUpPoolToMemorizeAllAcquiredAndReleasedConnections(
        driver,
        acquiredConnections,
        releasedConnections
      )

      const session = driver.session()
      session
        .run('MATCH (n) RETURN n.name')
        .then(() => {
          session.close(() => {
            driver.close()
            server.exit(code => {
              expect(code).toEqual(0)

              // two connections should have been acquired: one for rediscovery and one for the query
              expect(acquiredConnections.length).toEqual(2)
              // same two connections should have been released
              expect(releasedConnections.length).toEqual(2)

              // verify that acquired connections are those that we released
              for (let i = 0; i < acquiredConnections.length; i++) {
                expect(acquiredConnections[i]).toBe(releasedConnections[i])
              }
              done()
            })
          })
        })
        .catch(console.log)
    })
  })

  it('should throw error when no records', done => {
    testForProtocolError(
      './test/resources/boltstub/v3/acquire_endpoints_no_records.script',
      done
    )
  })

  it('should throw error when no TTL entry', done => {
    testForProtocolError(
      './test/resources/boltstub/v3/acquire_endpoints_no_ttl_field.script',
      done
    )
  })

  it('should throw error when no servers entry', done => {
    testForProtocolError(
      './test/resources/boltstub/v3/acquire_endpoints_no_servers_field.script',
      done
    )
  })

  it('should throw error when unparsable TTL entry', done => {
    testForProtocolError(
      './test/resources/boltstub/v3/acquire_endpoints_unparsable_ttl.script',
      done
    )
  })

  it('should throw error when multiple records', done => {
    testForProtocolError(
      './test/resources/boltstub/v3/acquire_endpoints_multiple_records.script',
      done
    )
  })

  it('should throw error on unparsable record', done => {
    testForProtocolError(
      './test/resources/boltstub/v3/acquire_endpoints_unparsable_servers.script',
      done
    )
  })

  it('should throw error when no routers', done => {
    testForProtocolError(
      './test/resources/boltstub/v3/acquire_endpoints_no_routers.script',
      done
    )
  })

  it('should throw error when no readers', done => {
    testForProtocolError(
      './test/resources/boltstub/v3/acquire_endpoints_no_readers.script',
      done
    )
  })

  it('should accept routing table with 1 router, 1 reader and 1 writer', done => {
    testRoutingTableAcceptance(
      {
        routers: ['127.0.0.1:9091'],
        readers: ['127.0.0.1:9092'],
        writers: ['127.0.0.1:9999']
      },
      9999,
      done
    )
  })

  it('should accept routing table with 2 routers, 1 reader and 1 writer', done => {
    testRoutingTableAcceptance(
      {
        routers: ['127.0.0.1:9091', '127.0.0.1:9092'],
        readers: ['127.0.0.1:9092'],
        writers: ['127.0.0.1:9999']
      },
      9999,
      done
    )
  })

  it('should accept routing table with 1 router, 2 readers and 1 writer', done => {
    testRoutingTableAcceptance(
      {
        routers: ['127.0.0.1:9091'],
        readers: ['127.0.0.1:9092', '127.0.0.1:9093'],
        writers: ['127.0.0.1:9999']
      },
      9999,
      done
    )
  })

  it('should accept routing table with 2 routers, 2 readers and 1 writer', done => {
    testRoutingTableAcceptance(
      {
        routers: ['127.0.0.1:9091', '127.0.0.1:9092'],
        readers: ['127.0.0.1:9093', '127.0.0.1:9094'],
        writers: ['127.0.0.1:9999']
      },
      9999,
      done
    )
  })

  it('should accept routing table with 1 router, 1 reader and 2 writers', done => {
    testRoutingTableAcceptance(
      {
        routers: ['127.0.0.1:9091'],
        readers: ['127.0.0.1:9092'],
        writers: ['127.0.0.1:9999', '127.0.0.1:9093']
      },
      9999,
      done
    )
  })

  it('should accept routing table with 2 routers, 1 reader and 2 writers', done => {
    testRoutingTableAcceptance(
      {
        routers: ['127.0.0.1:9091', '127.0.0.1:9092'],
        readers: ['127.0.0.1:9093'],
        writers: ['127.0.0.1:9999', '127.0.0.1:9094']
      },
      9999,
      done
    )
  })

  it('should accept routing table with 1 router, 2 readers and 2 writers', done => {
    testRoutingTableAcceptance(
      {
        routers: ['127.0.0.1:9091'],
        readers: ['127.0.0.1:9092', '127.0.0.1:9093'],
        writers: ['127.0.0.1:9999', '127.0.0.1:9094']
      },
      9999,
      done
    )
  })

  it('should accept routing table with 2 routers, 2 readers and 2 writers', done => {
    testRoutingTableAcceptance(
      {
        routers: ['127.0.0.1:9091', '127.0.0.1:9092'],
        readers: ['127.0.0.1:9093', '127.0.0.1:9094'],
        writers: ['127.0.0.1:9999', '127.0.0.1:9095']
      },
      9999,
      done
    )
  })

  it('should send and receive bookmark', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const writer = boltStub.start(
      './test/resources/boltstub/v3/write_tx_with_bookmarks.script',
      9007
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')

      const session = driver.session({ bookmarks: ['neo4j:bookmark:v1:tx42'] })
      const tx = session.beginTransaction()
      tx.run("CREATE (n {name:'Bob'})").then(() => {
        tx.commit().then(() => {
          expect(session.lastBookmark()).toEqual('neo4j:bookmark:v1:tx4242')

          session.close()
          driver.close()

          router.exit(code1 => {
            writer.exit(code2 => {
              expect(code1).toEqual(0)
              expect(code2).toEqual(0)
              done()
            })
          })
        })
      })
    })
  })

  it('should send initial bookmark without access mode', done => {
    testWriteSessionWithAccessModeAndBookmark(
      null,
      'neo4j:bookmark:v1:tx42',
      done
    )
  })

  it('should use write session mode and initial bookmark', done => {
    testWriteSessionWithAccessModeAndBookmark(
      WRITE,
      'neo4j:bookmark:v1:tx42',
      done
    )
  })

  it('should use read session mode and initial bookmark', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const writer = boltStub.start(
      './test/resources/boltstub/v3/read_tx_with_bookmarks.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')

      const session = driver.session({
        defaultAccessMode: READ,
        bookmarks: ['neo4j:bookmark:v1:tx42']
      })
      const tx = session.beginTransaction()
      tx.run('MATCH (n) RETURN n.name AS name').then(result => {
        const records = result.records
        expect(records.length).toEqual(2)
        expect(records[0].get('name')).toEqual('Bob')
        expect(records[1].get('name')).toEqual('Alice')

        tx.commit().then(() => {
          expect(session.lastBookmark()).toEqual('neo4j:bookmark:v1:tx4242')

          session.close()
          driver.close()

          router.exit(code1 => {
            writer.exit(code2 => {
              expect(code1).toEqual(0)
              expect(code2).toEqual(0)
              done()
            })
          })
        })
      })
    })
  })

  it('should pass bookmark from transaction to transaction', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_three_servers_set_2.script',
      9001
    )
    const writer = boltStub.start(
      './test/resources/boltstub/v3/write_read_tx_with_bookmarks.script',
      9010
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')

      const session = driver.session({ bookmarks: ['neo4j:bookmark:v1:tx42'] })
      const writeTx = session.beginTransaction()
      writeTx.run("CREATE (n {name:'Bob'})").then(() => {
        writeTx.commit().then(() => {
          expect(session.lastBookmark()).toEqual('neo4j:bookmark:v1:tx4242')

          const readTx = session.beginTransaction()
          readTx.run('MATCH (n) RETURN n.name AS name').then(result => {
            const records = result.records
            expect(records.length).toEqual(1)
            expect(records[0].get('name')).toEqual('Bob')

            readTx.commit().then(() => {
              expect(session.lastBookmark()).toEqual(
                'neo4j:bookmark:v1:tx424242'
              )

              session.close()
              driver.close()

              router.exit(code1 => {
                writer.exit(code2 => {
                  expect(code1).toEqual(0)
                  expect(code2).toEqual(0)
                  done()
                })
              })
            })
          })
        })
      })
    })
  })

  it('should retry read transaction until success', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const brokenReader = boltStub.start(
      './test/resources/boltstub/v3/read_tx_dead.script',
      9005
    )
    const reader = boltStub.start(
      './test/resources/boltstub/v3/read_tx.script',
      9006
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      const session = driver.session()

      let invocations = 0
      const resultPromise = session.readTransaction(tx => {
        invocations++
        return tx.run('MATCH (n) RETURN n.name')
      })

      resultPromise.then(result => {
        expect(result.records.length).toEqual(3)
        expect(invocations).toEqual(2)

        session.close(() => {
          driver.close()
          router.exit(code1 => {
            brokenReader.exit(code2 => {
              reader.exit(code3 => {
                expect(code1).toEqual(0)
                expect(code2).toEqual(0)
                expect(code3).toEqual(0)
                done()
              })
            })
          })
        })
      })
    })
  })

  it('should retry write transaction until success', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const brokenWriter = boltStub.start(
      './test/resources/boltstub/v3/write_tx_dead.script',
      9007
    )
    const writer = boltStub.start(
      './test/resources/boltstub/v3/write_tx.script',
      9008
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      const session = driver.session()

      let invocations = 0
      const resultPromise = session.writeTransaction(tx => {
        invocations++
        return tx.run("CREATE (n {name:'Bob'})")
      })

      resultPromise.then(result => {
        expect(result.records.length).toEqual(0)
        expect(invocations).toEqual(2)

        session.close(() => {
          driver.close()
          router.exit(code1 => {
            brokenWriter.exit(code2 => {
              writer.exit(code3 => {
                expect(code1).toEqual(0)
                expect(code2).toEqual(0)
                expect(code3).toEqual(0)
                done()
              })
            })
          })
        })
      })
    })
  })

  it('should retry read transaction until failure', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const brokenReader1 = boltStub.start(
      './test/resources/boltstub/v3/read_tx_dead.script',
      9005
    )
    const brokenReader2 = boltStub.start(
      './test/resources/boltstub/v3/read_tx_dead.script',
      9006
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      const session = driver.session()

      let clock
      let invocations = 0
      const resultPromise = session.readTransaction(tx => {
        invocations++
        if (invocations === 2) {
          // make retries stop after two invocations
          clock = moveTime30SecondsForward()
        }
        return tx.run('MATCH (n) RETURN n.name')
      })

      resultPromise.catch(error => {
        removeTimeMocking(clock) // uninstall lolex mocking to make test complete, boltkit uses timers

        expect(error.code).toEqual(SESSION_EXPIRED)
        expect(invocations).toEqual(2)

        session.close(() => {
          driver.close()
          router.exit(code1 => {
            brokenReader1.exit(code2 => {
              brokenReader2.exit(code3 => {
                expect(code1).toEqual(0)
                expect(code2).toEqual(0)
                expect(code3).toEqual(0)
                done()
              })
            })
          })
        })
      })
    })
  })

  it('should retry write transaction until failure', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const brokenWriter1 = boltStub.start(
      './test/resources/boltstub/v3/write_tx_dead.script',
      9007
    )
    const brokenWriter2 = boltStub.start(
      './test/resources/boltstub/v3/write_tx_dead.script',
      9008
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      const session = driver.session()

      let clock = null
      let invocations = 0
      const resultPromise = session.writeTransaction(tx => {
        invocations++
        if (invocations === 2) {
          // make retries stop after two invocations
          clock = moveTime30SecondsForward()
        }
        return tx.run("CREATE (n {name:'Bob'})")
      })

      resultPromise.catch(error => {
        removeTimeMocking(clock) // uninstall lolex mocking to make test complete, boltStub uses timers

        expect(error.code).toEqual(SESSION_EXPIRED)
        expect(invocations).toEqual(2)

        session.close(() => {
          driver.close()
          router.exit(code1 => {
            brokenWriter1.exit(code2 => {
              brokenWriter2.exit(code3 => {
                expect(code1).toEqual(0)
                expect(code2).toEqual(0)
                expect(code3).toEqual(0)
                done()
              })
            })
          })
        })
      })
    })
  })

  it('should retry read transaction and perform rediscovery until success', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router1 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9010
    )
    const brokenReader1 = boltStub.start(
      './test/resources/boltstub/v3/read_tx_dead.script',
      9005
    )
    const brokenReader2 = boltStub.start(
      './test/resources/boltstub/v3/read_tx_dead.script',
      9006
    )
    const router2 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_three_servers_set_3.script',
      9001
    )
    const reader = boltStub.start(
      './test/resources/boltstub/v3/read_tx.script',
      9002
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9010')
      const session = driver.session()

      let invocations = 0
      const resultPromise = session.readTransaction(tx => {
        invocations++
        return tx.run('MATCH (n) RETURN n.name')
      })

      resultPromise.then(result => {
        expect(result.records.length).toEqual(3)
        expect(invocations).toEqual(3)

        session.close(() => {
          driver.close()
          router1.exit(code1 => {
            brokenReader1.exit(code2 => {
              brokenReader2.exit(code3 => {
                router2.exit(code4 => {
                  reader.exit(code5 => {
                    expect(code1).toEqual(0)
                    expect(code2).toEqual(0)
                    expect(code3).toEqual(0)
                    expect(code4).toEqual(0)
                    expect(code5).toEqual(0)
                    done()
                  })
                })
              })
            })
          })
        })
      })
    })
  })

  it('should retry write transaction and perform rediscovery until success', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router1 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9010
    )
    const brokenWriter1 = boltStub.start(
      './test/resources/boltstub/v3/write_tx_dead.script',
      9007
    )
    const brokenWriter2 = boltStub.start(
      './test/resources/boltstub/v3/write_tx_dead.script',
      9008
    )
    const router2 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_three_servers_set_3.script',
      9002
    )
    const writer = boltStub.start(
      './test/resources/boltstub/v3/write_tx.script',
      9009
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9010')
      const session = driver.session()

      let invocations = 0
      const resultPromise = session.writeTransaction(tx => {
        invocations++
        return tx.run("CREATE (n {name:'Bob'})")
      })

      resultPromise.then(result => {
        expect(result.records.length).toEqual(0)
        expect(invocations).toEqual(3)

        session.close(() => {
          driver.close()
          router1.exit(code1 => {
            brokenWriter1.exit(code2 => {
              brokenWriter2.exit(code3 => {
                router2.exit(code4 => {
                  writer.exit(code5 => {
                    expect(code1).toEqual(0)
                    expect(code2).toEqual(0)
                    expect(code3).toEqual(0)
                    expect(code4).toEqual(0)
                    expect(code5).toEqual(0)
                    done()
                  })
                })
              })
            })
          })
        })
      })
    })
  })

  it('should use seed router for rediscovery when all other routers are dead', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    // use scripts that exit eagerly when they are executed to simulate failed servers
    const router1 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_and_exit.script',
      9010
    )
    const tmpReader = boltStub.start(
      './test/resources/boltstub/v3/read_and_exit.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9010')

      // run a dummy query to force routing table initialization
      const session = driver.session({ defaultAccessMode: READ })
      session.run('MATCH (n) RETURN n.name').then(result => {
        expect(result.records.length).toEqual(3)
        session.close(() => {
          // stop existing router and reader
          router1.exit(code1 => {
            tmpReader.exit(code2 => {
              // at this point previously used router and reader should be dead
              expect(code1).toEqual(0)
              expect(code2).toEqual(0)

              // start new router on the same port with different script that contains itself as reader
              const router2 = boltStub.start(
                './test/resources/boltstub/v3/acquire_endpoints_self_as_reader.script',
                9010
              )

              boltStub.run(() => {
                session
                  .readTransaction(tx =>
                    tx.run('MATCH (n) RETURN n.name AS name')
                  )
                  .then(result => {
                    const records = result.records
                    expect(records.length).toEqual(2)
                    expect(records[0].get('name')).toEqual('Bob')
                    expect(records[1].get('name')).toEqual('Alice')

                    session.close(() => {
                      driver.close()
                      router2.exit(code => {
                        expect(code).toEqual(0)
                        done()
                      })
                    })
                  })
              })
            })
          })
        })
      })
    })
  })

  it('should use resolved seed router addresses for rediscovery when all other routers are dead', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router1 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_and_exit.script',
      9011
    )
    // start new router on a different port to emulate host name resolution
    // this router uses different script that contains itself as reader
    const router2 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_self_as_reader.script',
      9009
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9010')
      // make seed address resolve to 3 different addresses (only last one has backing stub server):
      setupFakeHostNameResolution(driver, '127.0.0.1:9010', [
        '127.0.0.1:9011',
        '127.0.0.1:9012',
        '127.0.0.1:9009'
      ])
      const session = driver.session()

      session
        .readTransaction(tx => tx.run('MATCH (n) RETURN n.name AS name'))
        .then(result => {
          const records = result.records
          expect(records.length).toEqual(2)
          expect(records[0].get('name')).toEqual('Bob')
          expect(records[1].get('name')).toEqual('Alice')

          session.close(() => {
            driver.close()
            router1.exit(code1 => {
              router2.exit(code2 => {
                expect(code1).toEqual(0)
                expect(code2).toEqual(0)
                done()
              })
            })
          })
        })
    })
  })

  it('should send routing context to server', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_with_context.script',
      9001
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver(
        'neo4j://127.0.0.1:9001/?policy=my_policy&region=china'
      )
      const session = driver.session()
      session.run('MATCH (n) RETURN n.name AS name').then(result => {
        const names = result.records.map(record => record.get('name'))
        expect(names).toEqual(['Alice', 'Bob'])

        session.close(() => {
          driver.close()
          router.exit(code => {
            expect(code).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should treat routing table with single router as valid', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_one_router.script',
      9010
    )
    const reader1 = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9003
    )
    const reader2 = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9004
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9010')
      const session = driver.session({ defaultAccessMode: READ })

      session.run('MATCH (n) RETURN n.name').then(result1 => {
        expect(result1.records.length).toEqual(3)
        expect(result1.summary.server.address).toEqual('127.0.0.1:9003')

        session.run('MATCH (n) RETURN n.name').then(result2 => {
          expect(result2.records.length).toEqual(3)
          expect(result2.summary.server.address).toEqual('127.0.0.1:9004')

          session.close(() => {
            driver.close()
            router.exit(code1 => {
              reader1.exit(code2 => {
                reader2.exit(code3 => {
                  expect(code1).toEqual(0)
                  expect(code2).toEqual(0)
                  expect(code3).toEqual(0)
                  done()
                })
              })
            })
          })
        })
      })
    })
  })

  it('should use routing table without writers for reads', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_no_writers.script',
      9001
    )
    const reader = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')

      const session = driver.session({ defaultAccessMode: READ })
      session.run('MATCH (n) RETURN n.name').then(result => {
        session.close(() => {
          expect(result.records.map(record => record.get(0))).toEqual([
            'Bob',
            'Alice',
            'Tina'
          ])

          driver.close()

          router.exit(code1 => {
            reader.exit(code2 => {
              expect(code1).toEqual(0)
              expect(code2).toEqual(0)
              done()
            })
          })
        })
      })
    })
  })

  it('should serve reads but fail writes when no writers available', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router1 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_no_writers.script',
      9001
    )
    const router2 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_no_writers.script',
      9002
    )
    const reader = boltStub.start(
      './test/resources/boltstub/v3/read_tx.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')

      const readSession = driver.session()

      readSession
        .readTransaction(tx => tx.run('MATCH (n) RETURN n.name'))
        .then(result => {
          readSession.close(() => {
            expect(result.records.map(record => record.get(0))).toEqual([
              'Bob',
              'Alice',
              'Tina'
            ])

            const writeSession = driver.session({ defaultAccessMode: WRITE })
            writeSession.run("CREATE (n {name:'Bob'})").catch(error => {
              expect(error.code).toEqual(neo4j.error.SESSION_EXPIRED)

              driver.close()

              router1.exit(code1 => {
                router2.exit(code2 => {
                  reader.exit(code3 => {
                    expect(code1).toEqual(0)
                    expect(code2).toEqual(0)
                    expect(code3).toEqual(0)
                    done()
                  })
                })
              })
            })
          })
        })
    })
  })

  it('should accept routing table without writers and then rediscover', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    // first router does not have itself in the resulting routing table so connection
    // towards it will be closed after rediscovery
    const router1 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_no_writers.script',
      9001
    )
    let router2 = null
    const reader = boltStub.start(
      './test/resources/boltstub/v3/read_tx.script',
      9005
    )
    const writer = boltStub.start(
      './test/resources/boltstub/v3/write.script',
      9007
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')

      const readSession = driver.session()

      readSession
        .readTransaction(tx => tx.run('MATCH (n) RETURN n.name'))
        .then(result => {
          readSession.close(() => {
            expect(result.records.map(record => record.get(0))).toEqual([
              'Bob',
              'Alice',
              'Tina'
            ])

            // start another router which knows about writes, use same address as the initial router
            router2 = boltStub.start(
              './test/resources/boltstub/v3/acquire_endpoints.script',
              9002
            )
            boltStub.run(() => {
              const writeSession = driver.session({ defaultAccessMode: WRITE })
              writeSession.run("CREATE (n {name:'Bob'})").then(result => {
                writeSession.close(() => {
                  expect(result.records).toEqual([])

                  driver.close()

                  router1.exit(code1 => {
                    router2.exit(code2 => {
                      reader.exit(code3 => {
                        writer.exit(code4 => {
                          expect(code1).toEqual(0)
                          expect(code2).toEqual(0)
                          expect(code3).toEqual(0)
                          expect(code4).toEqual(0)
                          done()
                        })
                      })
                    })
                  })
                })
              })
            })
          })
        })
    })
  })

  it('should use resolved seed router for discovery after accepting a table without writers', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const seedRouter = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_no_writers.script',
      9001
    )
    const resolvedSeedRouter = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9020
    )
    const reader = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9005
    )
    const writer = boltStub.start(
      './test/resources/boltstub/v3/write.script',
      9007
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')

      const readSession = driver.session({ defaultAccessMode: READ })
      readSession.run('MATCH (n) RETURN n.name').then(result => {
        readSession.close(() => {
          expect(result.records.map(record => record.get(0))).toEqual([
            'Bob',
            'Alice',
            'Tina'
          ])

          setupFakeHostNameResolution(driver, '127.0.0.1:9001', [
            '127.0.0.1:9020'
          ])

          const writeSession = driver.session({ defaultAccessMode: WRITE })
          writeSession.run("CREATE (n {name:'Bob'})").then(result => {
            writeSession.close(() => {
              expect(result.records).toEqual([])

              driver.close()

              seedRouter.exit(code1 => {
                resolvedSeedRouter.exit(code2 => {
                  reader.exit(code3 => {
                    writer.exit(code4 => {
                      expect(code1).toEqual(0)
                      expect(code2).toEqual(0)
                      expect(code3).toEqual(0)
                      expect(code4).toEqual(0)
                      done()
                    })
                  })
                })
              })
            })
          })
        })
      })
    })
  })

  it('should fail rediscovery on auth error', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/no_auth.script',
      9010
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9010')
      const session = driver.session()
      session.run('RETURN 1').catch(error => {
        expect(error.code).toEqual('Neo.ClientError.Security.Unauthorized')
        expect(error.message).toEqual('Some server auth error message')

        session.close(() => {
          driver.close()
          router.exit(code => {
            expect(code).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should send multiple bookmarks', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9010
    )
    const writer = boltStub.start(
      './test/resources/boltstub/v3/write_tx_with_multiple_bookmarks.script',
      9007
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9010')

      const bookmarks = [
        'neo4j:bookmark:v1:tx5',
        'neo4j:bookmark:v1:tx29',
        'neo4j:bookmark:v1:tx94',
        'neo4j:bookmark:v1:tx56',
        'neo4j:bookmark:v1:tx16',
        'neo4j:bookmark:v1:tx68'
      ]
      const session = driver.session({ defaultAccessMode: WRITE, bookmarks })
      const tx = session.beginTransaction()

      tx.run(`CREATE (n {name:'Bob'})`).then(() => {
        tx.commit().then(() => {
          expect(session.lastBookmark()).toEqual('neo4j:bookmark:v1:tx95')

          session.close()
          driver.close()

          router.exit(code1 => {
            writer.exit(code2 => {
              expect(code1).toEqual(0)
              expect(code2).toEqual(0)
              done()
            })
          })
        })
      })
    })
  })

  it('should forget writer on database unavailable error', done => {
    testAddressPurgeOnDatabaseError(
      './test/resources/boltstub/v3/write_database_unavailable.script',
      `CREATE (n {name:'Bob'})`,
      WRITE,
      done
    )
  })

  it('should forget reader on database unavailable error', done => {
    testAddressPurgeOnDatabaseError(
      './test/resources/boltstub/v3/read_database_unavailable.script',
      `RETURN 1`,
      READ,
      done
    )
  })

  it('should use resolver function that returns array during first discovery', done => {
    testResolverFunctionDuringFirstDiscovery(['127.0.0.1:9010'], done)
  })

  it('should use resolver function that returns promise during first discovery', done => {
    testResolverFunctionDuringFirstDiscovery(
      Promise.resolve(['127.0.0.1:9010']),
      done
    )
  })

  it('should fail first discovery when configured resolver function throws', done => {
    const failureFunction = () => {
      throw new Error('Broken resolver')
    }
    testResolverFunctionFailureDuringFirstDiscovery(
      failureFunction,
      null,
      'Broken resolver',
      done
    )
  })

  it('should fail first discovery when configured resolver function returns no addresses', done => {
    const failureFunction = () => {
      return []
    }
    testResolverFunctionFailureDuringFirstDiscovery(
      failureFunction,
      SERVICE_UNAVAILABLE,
      'No routing servers available',
      done
    )
  })

  it('should fail first discovery when configured resolver function returns a string instead of array of addresses', done => {
    const failureFunction = () => {
      return 'Hello'
    }
    testResolverFunctionFailureDuringFirstDiscovery(
      failureFunction,
      null,
      'Configured resolver function should either return an array of addresses',
      done
    )
  })

  it('should use resolver function during rediscovery when existing routers fail', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    const router1 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_two_servers_set_1.script',
      9001
    )
    const router2 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9042
    )
    const reader = boltStub.start(
      './test/resources/boltstub/v3/read_tx.script',
      9005
    )

    boltStub.run(() => {
      const resolverFunction = address => {
        if (address === '127.0.0.1:9000') {
          return ['127.0.0.1:9010', '127.0.0.1:9001', '127.0.0.1:9042']
        }
        throw new Error(`Unexpected address ${address}`)
      }

      const driver = boltStub.newDriver('neo4j://127.0.0.1:9000', {
        resolver: resolverFunction
      })

      const session = driver.session({ defaultAccessMode: READ })
      // run a query that should trigger discovery against 9001 and then read from it
      session
        .run('MATCH (n) RETURN n.name AS name')
        .then(result => {
          expect(result.records.map(record => record.get(0))).toEqual([
            'Alice',
            'Bob',
            'Eve'
          ])

          // 9001 should now exit and read transaction should fail to read from all existing readers
          // it should then rediscover using addresses from resolver, only 9042 of them works and can respond with table containing reader 9005
          session
            .readTransaction(tx => tx.run('MATCH (n) RETURN n.name'))
            .then(result => {
              expect(result.records.map(record => record.get(0))).toEqual([
                'Bob',
                'Alice',
                'Tina'
              ])

              assertHasRouters(driver, [
                '127.0.0.1:9001',
                '127.0.0.1:9002',
                '127.0.0.1:9003'
              ])
              assertHasReaders(driver, ['127.0.0.1:9005', '127.0.0.1:9006'])
              assertHasWriters(driver, ['127.0.0.1:9007', '127.0.0.1:9008'])

              session.close(() => {
                driver.close()
                router1.exit(code1 => {
                  router2.exit(code2 => {
                    reader.exit(code3 => {
                      expect(code1).toEqual(0)
                      expect(code2).toEqual(0)
                      expect(code3).toEqual(0)
                      done()
                    })
                  })
                })
              })
            })
            .catch(done.fail)
        })
        .catch(done.fail)
    })
  })

  it('should connect to cluster when disableLosslessIntegers is on', done => {
    testDiscoveryAndReadQueryInAutoCommitTx(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      { disableLosslessIntegers: true },
      done
    )
  })

  it('should send read access mode on statement metadata', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const readServer = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session({ defaultAccessMode: READ })
      session.run('MATCH (n) RETURN n.name').then(res => {
        session.close()

        // Then
        expect(res.records[0].get('n.name')).toEqual('Bob')
        expect(res.records[1].get('n.name')).toEqual('Alice')
        expect(res.records[2].get('n.name')).toEqual('Tina')
        driver.close()
        seedServer.exit(code1 => {
          readServer.exit(code2 => {
            expect(code1).toEqual(0)
            expect(code2).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should send read access mode on statement metadata with read transaction', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const readServer = boltStub.start(
      './test/resources/boltstub/v3/read_tx.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session({ defaultAccessMode: READ })
      session
        .readTransaction(tx => tx.run('MATCH (n) RETURN n.name'))
        .then(res => {
          session.close()

          // Then
          expect(res.records[0].get('n.name')).toEqual('Bob')
          expect(res.records[1].get('n.name')).toEqual('Alice')
          expect(res.records[2].get('n.name')).toEqual('Tina')
          driver.close()
          seedServer.exit(code1 => {
            readServer.exit(code2 => {
              expect(code1).toEqual(0)
              expect(code2).toEqual(0)
              done()
            })
          })
        })
    })
  })

  it('should not send write access mode on statement metadata', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const writeServer = boltStub.start(
      './test/resources/boltstub/v3/write.script',
      9007
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session({ defaultAccessMode: WRITE })
      session.run("CREATE (n {name:'Bob'})").then(res => {
        session.close()
        driver.close()
        seedServer.exit(code1 => {
          writeServer.exit(code2 => {
            expect(code1).toEqual(0)
            expect(code2).toEqual(0)
            done()
          })
        })
      })
    })
  })

  it('should not send write access mode on statement metadata with write transaction', done => {
    if (!boltStub.supported) {
      done()
      return
    }
    // Given
    const seedServer = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const writeServer = boltStub.start(
      './test/resources/boltstub/v3/write_tx.script',
      9007
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
      // When
      const session = driver.session({ defaultAccessMode: WRITE })
      session
        .writeTransaction(tx => tx.run("CREATE (n {name:'Bob'})"))
        .then(res => {
          session.close()
          driver.close()
          seedServer.exit(code1 => {
            writeServer.exit(code2 => {
              expect(code1).toEqual(0)
              expect(code2).toEqual(0)
              done()
            })
          })
        })
    })
  })

  it('should revert to initial router if the only known router returns invalid routing table', done => {
    if (!boltStub.supported) {
      done()
      return
    }

    // the first seed to get the routing table
    // the returned routing table includes a non-reachable read-server and points to only one router
    // which will return an invalid routing table
    const router1 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_three_servers_set_2.script',
      9001
    )
    // returns an empty routing table
    const router2 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_no_servers.script',
      9004
    )
    // returns a normal routing table
    const router3 = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints_three_servers_set_1.script',
      9003
    )
    // ordinary read server
    const reader = boltStub.start(
      './test/resources/boltstub/v3/read_tx.script',
      9002
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://my.virtual.host:8080', {
        resolver: address => ['127.0.0.1:9001', '127.0.0.1:9003']
      })

      const session = driver.session({ defaultAccessMode: READ })
      session
        .readTransaction(tx => tx.run('MATCH (n) RETURN n.name'))
        .then(res => {
          session.close()
          driver.close()
          router1.exit(code1 => {
            router2.exit(code2 => {
              router3.exit(code3 => {
                reader.exit(code4 => {
                  expect(code1).toEqual(0)
                  expect(code2).toEqual(0)
                  expect(code3).toEqual(0)
                  expect(code4).toEqual(0)
                  done()
                })
              })
            })
          })
        })
        .catch(error => done.fail(error))
    })
  })

  describe('multi-Database', () => {
    function verifyDiscoverAndRead (script, database, done) {
      if (!boltStub.supported) {
        done()
        return
      }

      // Given
      const server = boltStub.start(
        `./test/resources/boltstub/v4/acquire_endpoints_${database ||
          'default_database'}.script`,
        9001
      )
      const readServer = boltStub.start(
        `./test/resources/boltstub/v4/${script}.script`,
        9005
      )

      boltStub.run(() => {
        const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
        // When
        const session = driver.session({
          database: database,
          defaultAccessMode: READ
        })
        session.run('MATCH (n) RETURN n.name').then(() => {
          session.close()
          // Then
          expect(
            hasAddressInConnectionPool(driver, '127.0.0.1:9001')
          ).toBeTruthy()
          expect(
            hasAddressInConnectionPool(driver, '127.0.0.1:9005')
          ).toBeTruthy()
          assertHasRouters(
            driver,
            ['127.0.0.1:9001', '127.0.0.1:9002', '127.0.0.1:9003'],
            database
          )
          assertHasReaders(
            driver,
            ['127.0.0.1:9005', '127.0.0.1:9006'],
            database
          )
          assertHasWriters(
            driver,
            ['127.0.0.1:9007', '127.0.0.1:9008'],
            database
          )

          driver.close()
          server.exit(code => {
            readServer.exit(readCode => {
              expect(code).toEqual(0)
              expect(readCode).toEqual(0)
              done()
            })
          })
        })
      })
    }

    function verifyDiscoverAndWrite (script, database, done) {
      if (!boltStub.supported) {
        done()
        return
      }

      // Given
      const server = boltStub.start(
        `./test/resources/boltstub/v4/acquire_endpoints_${database ||
          'default_database'}.script`,
        9001
      )
      const writeServer = boltStub.start(
        `./test/resources/boltstub/v4/${script}.script`,
        9007
      )

      boltStub.run(() => {
        const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
        // When
        const session = driver.session({ database: database })
        session.run("CREATE (n {name:'Bob'})").then(() => {
          session.close()
          // Then
          expect(
            hasAddressInConnectionPool(driver, '127.0.0.1:9001')
          ).toBeTruthy()
          expect(
            hasAddressInConnectionPool(driver, '127.0.0.1:9007')
          ).toBeTruthy()
          assertHasRouters(
            driver,
            ['127.0.0.1:9001', '127.0.0.1:9002', '127.0.0.1:9003'],
            database
          )
          assertHasReaders(
            driver,
            ['127.0.0.1:9005', '127.0.0.1:9006'],
            database
          )
          assertHasWriters(
            driver,
            ['127.0.0.1:9007', '127.0.0.1:9008'],
            database
          )

          driver.close()
          server.exit(code => {
            writeServer.exit(writeCode => {
              expect(code).toEqual(0)
              expect(writeCode).toEqual(0)
              done()
            })
          })
        })
      })
    }

    it('should discover servers for default database and read', done => {
      verifyDiscoverAndRead('read', '', done)
    })

    it('should discover servers for aDatabase and read', done => {
      verifyDiscoverAndRead('read_from_aDatabase', 'aDatabase', done)
    })

    it('should discover servers for default database and write', done => {
      verifyDiscoverAndWrite('write', '', done)
    })

    it('should discover servers for aDatabase and write', done => {
      verifyDiscoverAndWrite('write_to_aDatabase', 'aDatabase', done)
    })

    it('should fail discovery if database not found', done => {
      if (!boltStub.supported) {
        done()
        return
      }

      // Given
      const server = boltStub.start(
        `./test/resources/boltstub/v4/acquire_endpoints_db_not_found.script`,
        9001
      )

      boltStub.run(() => {
        const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')
        // When
        const session = driver.session({ database: 'aDatabase' })

        session.run('CREATE ()').catch(error => {
          // Then
          expect(error.code).toEqual(
            'Neo.ClientError.Database.DatabaseNotFound'
          )
          expect(error.message).toEqual('database not found')

          session.close()
          driver.close()
          server.exit(code => {
            expect(code).toEqual(0)
            done()
          })
        })
      })
    })

    it('should try next server for empty routing table response', done => {
      if (!boltStub.supported) {
        done()
        return
      }

      // Given
      const router1 = boltStub.start(
        `./test/resources/boltstub/v4/acquire_endpoints_aDatabase_no_servers.script`,
        9001
      )
      const router2 = boltStub.start(
        `./test/resources/boltstub/v4/acquire_endpoints_aDatabase.script`,
        9002
      )
      const reader1 = boltStub.start(
        `./test/resources/boltstub/v4/read_from_aDatabase.script`,
        9005
      )

      boltStub.run(() => {
        const driver = boltStub.newDriver('neo4j://127.0.0.1:9000', {
          resolver: address => [
            'neo4j://127.0.0.1:9001',
            'neo4j://127.0.0.1:9002'
          ]
        })

        // When
        const session = driver.session({
          database: 'aDatabase',
          defaultAccessMode: READ
        })
        session.run('MATCH (n) RETURN n.name').then(result => {
          expect(result.records.map(record => record.get(0))).toEqual([
            'Bob',
            'Alice',
            'Tina'
          ])

          session.close()
          driver.close()
          router1.exit(code1 => {
            router2.exit(code2 => {
              reader1.exit(code3 => {
                expect(code1).toEqual(0)
                expect(code2).toEqual(0)
                expect(code3).toEqual(0)
                done()
              })
            })
          })
        })
      })
    })
  })

  function testAddressPurgeOnDatabaseError (script, query, accessMode, done) {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9010
    )

    const serverPort = accessMode === READ ? 9005 : 9007
    const serverAddress = '127.0.0.1:' + serverPort
    const server = boltStub.start(script, serverPort)

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9010')

      const session = driver.session({ defaultAccessMode: accessMode })
      session.run(query).catch(error => {
        expect(error.message).toEqual('Database is busy doing store copy')
        expect(error.code).toEqual(
          'Neo.TransientError.General.DatabaseUnavailable'
        )

        expect(hasAddressInConnectionPool(driver, serverAddress)).toBeFalsy()
        expect(hasRouterInRoutingTable(driver, serverAddress)).toBeFalsy()
        expect(hasReaderInRoutingTable(driver, serverAddress)).toBeFalsy()
        expect(hasWriterInRoutingTable(driver, serverAddress)).toBeFalsy()

        session.close(() => {
          driver.close()

          router.exit(code1 => {
            server.exit(code2 => {
              expect(code1).toEqual(0)
              expect(code2).toEqual(0)
              done()
            })
          })
        })
      })
    })
  }

  function moveTime30SecondsForward () {
    const currentTime = Date.now()
    const clock = lolex.install()
    clock.setSystemTime(currentTime + 30 * 1000 + 1)
    return clock
  }

  function removeTimeMocking (clock) {
    if (clock) {
      clock.uninstall()
    }
  }

  function testWriteSessionWithAccessModeAndBookmark (
    accessMode,
    bookmark,
    done
  ) {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9001
    )
    const writer = boltStub.start(
      './test/resources/boltstub/v3/write_tx_with_bookmarks.script',
      9007
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')

      const session = driver.session({
        defaultAccessMode: accessMode,
        bookmarks: [bookmark]
      })
      const tx = session.beginTransaction()
      tx.run("CREATE (n {name:'Bob'})").then(() => {
        tx.commit().then(() => {
          expect(session.lastBookmark()).toEqual('neo4j:bookmark:v1:tx4242')

          session.close()
          driver.close()

          router.exit(code1 => {
            writer.exit(code2 => {
              expect(code1).toEqual(0)
              expect(code2).toEqual(0)
              done()
            })
          })
        })
      })
    })
  }

  function testDiscoveryAndReadQueryInAutoCommitTx (
    routerScript,
    driverConfig,
    done
  ) {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(routerScript, 9001)
    const reader = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9005
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001', driverConfig)

      const session = driver.session({ defaultAccessMode: READ })
      session
        .run('MATCH (n) RETURN n.name')
        .then(result => {
          expect(result.records.map(record => record.get(0))).toEqual([
            'Bob',
            'Alice',
            'Tina'
          ])
          session.close()
          driver.close()
          router.exit(code1 => {
            reader.exit(code2 => {
              expect(code1).toEqual(0)
              expect(code2).toEqual(0)
              done()
            })
          })
        })
        .catch(done.fail)
    })
  }

  function testForProtocolError (scriptFile, done) {
    if (!boltStub.supported) {
      done()
      return
    }

    const server = boltStub.start(scriptFile, 9001)

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:9001')

      const session = driver.session()
      session.run('MATCH (n) RETURN n.name').catch(error => {
        expect(error.code).toEqual(neo4j.error.SERVICE_UNAVAILABLE)

        session.close()
        driver.close()

        server.exit(code => {
          expect(code).toEqual(0)
          done()
        })
      })
    })
  }

  function testRoutingTableAcceptance (clusterMembers, port, done) {
    if (!boltStub.supported) {
      done()
      return
    }

    const { routers, readers, writers } = clusterMembers
    const params = {
      routers: joinStrings(routers),
      readers: joinStrings(readers),
      writers: joinStrings(writers)
    }
    const server = boltStub.startWithTemplate(
      './test/resources/boltstub/v3/acquire_endpoints_template.script',
      params,
      port
    )

    boltStub.run(() => {
      const driver = boltStub.newDriver('neo4j://127.0.0.1:' + port)

      const session = driver.session()
      session.run('MATCH (n) RETURN n.name').then(result => {
        expect(result.summary.server.address).toEqual('127.0.0.1:' + port)

        session.close()
        driver.close()

        server.exit(code => {
          expect(code).toEqual(0)
          done()
        })
      })
    })
  }

  function setUpPoolToMemorizeAllAcquiredAndReleasedConnections (
    driver,
    acquiredConnections,
    releasedConnections
  ) {
    // make connection pool remember all acquired connections
    const connectionPool = getConnectionPool(driver)

    const originalAcquire = connectionPool.acquire.bind(connectionPool)
    const memorizingAcquire = (...args) => {
      return originalAcquire(...args).then(connection => {
        acquiredConnections.push(connection)
        return connection
      })
    }
    connectionPool.acquire = memorizingAcquire

    // make connection pool remember all released connections
    const originalRelease = connectionPool._release
    const rememberingRelease = (key, resource) => {
      originalRelease(key, resource)
      releasedConnections.push(resource)
    }
    connectionPool._release = rememberingRelease
  }

  function hasAddressInConnectionPool (driver, address) {
    return getConnectionPool(driver).has(ServerAddress.fromUrl(address))
  }

  function hasRouterInRoutingTable (driver, expectedRouter, database) {
    return (
      getRoutingTable(driver, database).routers.indexOf(
        ServerAddress.fromUrl(expectedRouter)
      ) > -1
    )
  }

  function hasReaderInRoutingTable (driver, expectedReader, database) {
    return (
      getRoutingTable(driver, database).readers.indexOf(
        ServerAddress.fromUrl(expectedReader)
      ) > -1
    )
  }

  function hasWriterInRoutingTable (driver, expectedWriter, database) {
    return (
      getRoutingTable(driver, database).writers.indexOf(
        ServerAddress.fromUrl(expectedWriter)
      ) > -1
    )
  }

  function assertNoRoutingTable (driver, database) {
    expect(getRoutingTable(driver, database)).toBeFalsy()
  }

  function assertHasRouters (driver, expectedRouters, database) {
    expect(
      getRoutingTable(driver, database).routers.map(s => s.asHostPort())
    ).toEqual(expectedRouters)
  }

  function assertHasReaders (driver, expectedReaders, database) {
    expect(
      getRoutingTable(driver, database).readers.map(s => s.asHostPort())
    ).toEqual(expectedReaders)
  }

  function assertHasWriters (driver, expectedWriters, database) {
    expect(
      getRoutingTable(driver, database).writers.map(s => s.asHostPort())
    ).toEqual(expectedWriters)
  }

  function setUpMemorizingRoutingTable (driver, database) {
    const memorizingRoutingTable = new MemorizingRoutingTable(
      getRoutingTable(driver, database)
    )
    setRoutingTable(driver, memorizingRoutingTable)
    return memorizingRoutingTable
  }

  function setupFakeHostNameResolution (driver, seedRouter, resolvedAddresses) {
    const connectionProvider = driver._getOrCreateConnectionProvider()
    connectionProvider._hostNameResolver._resolverFunction = function (address) {
      if (address === seedRouter) {
        return Promise.resolve(resolvedAddresses)
      }
      return Promise.reject(
        new Error('Unexpected seed router address ' + address)
      )
    }
  }

  function getConnectionPool (driver) {
    const connectionProvider = driver._getOrCreateConnectionProvider()
    return connectionProvider._connectionPool
  }

  function getRoutingTable (driver, database) {
    const connectionProvider = driver._getOrCreateConnectionProvider()
    return connectionProvider._routingTables[database || '']
  }

  function setRoutingTable (driver, newRoutingTable) {
    const connectionProvider = driver._getOrCreateConnectionProvider()
    connectionProvider._routingTables[
      newRoutingTable.database
    ] = newRoutingTable
  }

  function joinStrings (array) {
    return '[' + array.map(s => '"' + s + '"').join(',') + ']'
  }

  function numberOfOpenConnections (driver) {
    return Object.keys(driver._connectionProvider._openConnections).length
  }

  function testResolverFunctionDuringFirstDiscovery (resolutionResult, done) {
    if (!boltStub.supported) {
      done()
      return
    }

    const router = boltStub.start(
      './test/resources/boltstub/v3/acquire_endpoints.script',
      9010
    )
    const reader = boltStub.start(
      './test/resources/boltstub/v3/read.script',
      9005
    )

    boltStub.run(() => {
      const resolverFunction = address => {
        if (address === 'neo4j.com:7687') {
          return resolutionResult
        }
        throw new Error(`Unexpected address ${address}`)
      }

      const driver = boltStub.newDriver('neo4j://neo4j.com', {
        resolver: resolverFunction
      })

      const session = driver.session({ defaultAccessMode: READ })
      session
        .run('MATCH (n) RETURN n.name')
        .then(result => {
          expect(result.records.map(record => record.get(0))).toEqual([
            'Bob',
            'Alice',
            'Tina'
          ])
          session.close(() => {
            driver.close()

            router.exit(code1 => {
              reader.exit(code2 => {
                expect(code1).toEqual(0)
                expect(code2).toEqual(0)
                done()
              })
            })
          })
        })
        .catch(done.fail)
    })
  }

  function testResolverFunctionFailureDuringFirstDiscovery (
    failureFunction,
    expectedCode,
    expectedMessage,
    done
  ) {
    if (!boltStub.supported) {
      done()
      return
    }

    const resolverFunction = address => {
      if (address === 'neo4j.com:8989') {
        return failureFunction()
      }
      throw new Error('Unexpected address')
    }

    const driver = boltStub.newDriver('neo4j://neo4j.com:8989', {
      resolver: resolverFunction
    })
    const session = driver.session()

    session
      .run('RETURN 1')
      .then(result => done.fail(result))
      .catch(error => {
        if (expectedCode) {
          expect(error.code).toEqual(expectedCode)
        }
        if (expectedMessage) {
          expect(error.message.indexOf(expectedMessage)).toBeGreaterThan(-1)
        }
        done()
      })
  }

  class MemorizingRoutingTable extends RoutingTable {
    constructor (initialTable) {
      super({
        database: initialTable.database,
        routers: initialTable.routers,
        readers: initialTable.readers,
        writers: initialTable.writers,
        expirationTime: initialTable.expirationTime
      })
      this._forgottenRouters = []
    }

    forgetRouter (address) {
      super.forgetRouter(address)
      this._forgottenRouters.push(address)
    }

    assertForgotRouters (expectedRouters) {
      expect(this._forgottenRouters.map(s => s.asHostPort())).toEqual(
        expectedRouters
      )
    }
  }
})
