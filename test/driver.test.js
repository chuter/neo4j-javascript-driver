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

import neo4j from '../src'
import sharedNeo4j from './internal/shared-neo4j'
import lolex from 'lolex'
import {
  DEFAULT_ACQUISITION_TIMEOUT,
  DEFAULT_MAX_SIZE
} from '../src/internal/pool-config'
import { ServerVersion, VERSION_4_0_0 } from '../src/internal/server-version'
import testUtils from './internal/test-utils'

describe('#integration driver', () => {
  let driver
  let serverVersion

  beforeAll(done => {
    const tmpDriver = neo4j.driver('bolt://localhost', sharedNeo4j.authToken)
    ServerVersion.fromDriver(tmpDriver).then(version => {
      tmpDriver.close()
      serverVersion = version
      done()
    })
  })

  afterEach(() => {
    if (driver) {
      driver.close()
      driver = null
    }
  })

  it('should expose sessions', () => {
    // Given
    driver = neo4j.driver('bolt://localhost', sharedNeo4j.authToken)

    // When
    const session = driver.session()

    // Then
    expect(session).not.toBeNull()
    driver.close()
  })

  it('should handle connection errors', async () => {
    // Given
    driver = neo4j.driver('bolt://local-host', sharedNeo4j.authToken)
    const session = driver.session()
    const txc = session.beginTransaction()
    try {
      await txc.run('RETURN 1')
      expect(true).toBeFalsy('exception expected')
    } catch (error) {
      expect(error.message).not.toBeNull()
      expect(error.code).toEqual(neo4j.error.SERVICE_UNAVAILABLE)
    } finally {
      session.close()
    }
  }, 10000)

  it('should fail with correct error message when connecting to port 80', done => {
    if (testUtils.isClient()) {
      // good error message is not available in browser
      done()
      return
    }

    driver = neo4j.driver('bolt://localhost:80', sharedNeo4j.authToken)

    driver
      .session()
      .run('RETURN 1')
      .then(result => {
        done.fail(
          'Should not be able to connect. Result: ' + JSON.stringify(result)
        )
      })
      .catch(error => {
        const doesNotContainAddress = error.message.indexOf(':80') < 0
        if (doesNotContainAddress) {
          done.fail(`Expected to contain ':80' but was: ${error.message}`)
        } else {
          expect(error.code).toEqual(neo4j.error.SERVICE_UNAVAILABLE)
          done()
        }
      })
  })

  it('should handle wrong scheme', () => {
    expect(() =>
      neo4j.driver('tank://localhost', sharedNeo4j.authToken)
    ).toThrow(new Error('Unknown scheme: tank'))
  })

  it('should handle URL parameter string', () => {
    expect(() => neo4j.driver({ uri: 'bolt://localhost' })).toThrowError(
      TypeError
    )

    expect(() => neo4j.driver(['bolt:localhost'])).toThrowError(TypeError)

    expect(() => {
      const driver = neo4j.driver(
        String('bolt://localhost'),
        sharedNeo4j.authToken
      )
      return driver.session()
    }).toBeDefined()
  })

  it('should fail early on wrong credentials', async () => {
    // Given
    driver = neo4j.driver('bolt://localhost', wrongCredentials())
    const session = driver.session()
    const txc = session.beginTransaction()
    try {
      await txc.run('RETURN 1')
      expect(true).toBeFalsy('exception expected')
    } catch (error) {
      expect(error.message).not.toBeNull()
      expect(error.code).toEqual('Neo.ClientError.Security.Unauthorized')
    } finally {
      session.close()
    }
  })

  it('should fail queries on wrong credentials', done => {
    driver = neo4j.driver('bolt://localhost', wrongCredentials())

    const session = driver.session()
    session.run('RETURN 1').catch(error => {
      expect(error.code).toEqual('Neo.ClientError.Security.Unauthorized')
      done()
    })
  })

  it('should indicate success early on correct credentials', done => {
    // Given
    driver = neo4j.driver('bolt://localhost', sharedNeo4j.authToken)

    // Expect
    driver.verifyConnectivity().then(server => {
      expect(server.address).toBeDefined()
      done()
    })
  })

  it('should be possible to pass a realm with basic auth tokens', done => {
    // Given
    driver = neo4j.driver(
      'bolt://localhost',
      neo4j.auth.basic(sharedNeo4j.username, sharedNeo4j.password, 'native')
    )

    // Expect
    driver.verifyConnectivity().then(server => {
      expect(server.address).toBeDefined()
      done()
    })
  })

  it('should be possible to create custom auth tokens', done => {
    // Given
    driver = neo4j.driver(
      'bolt://localhost',
      neo4j.auth.custom(
        sharedNeo4j.username,
        sharedNeo4j.password,
        'native',
        'basic'
      )
    )

    // Expect
    driver.verifyConnectivity().then(server => {
      expect(server.address).toBeDefined()
      done()
    })
  })

  it('should be possible to create custom auth tokens with additional parameters', done => {
    // Given
    driver = neo4j.driver(
      'bolt://localhost',
      neo4j.auth.custom(
        sharedNeo4j.username,
        sharedNeo4j.password,
        'native',
        'basic',
        { secret: 42 }
      )
    )

    // Expect
    driver.verifyConnectivity().then(server => {
      expect(server.address).toBeDefined()
      done()
    })
  })

  it('should fail nicely when connecting with routing to standalone server', async () => {
    if (!routingProcedureOnlyAvailableOnCores()) {
      return Promise.resolve(null)
    }

    // Given
    driver = neo4j.driver('neo4j://localhost', sharedNeo4j.authToken)
    const session = driver.session()
    try {
      await session.run('RETURN 1')
      expect(true).toBeFalsy('exception expected')
    } catch (error) {
      expect(error.message).toContain(
        'Could not perform discovery. No routing servers available.'
      )
      expect(error.code).toEqual(neo4j.error.SERVICE_UNAVAILABLE)
    } finally {
      session.close()
    }
  })

  it('should have correct user agent', () => {
    const directDriver = neo4j.driver('bolt://localhost')
    expect(directDriver._userAgent).toBe('neo4j-javascript/0.0.0-dev')
    directDriver.close()

    const routingDriver = neo4j.driver('neo4j://localhost')
    expect(routingDriver._userAgent).toBe('neo4j-javascript/0.0.0-dev')
    routingDriver.close()
  })

  it('should fail when bolt:// scheme used with routing params', () => {
    expect(() =>
      neo4j.driver('bolt://localhost:7687/?policy=my_policy')
    ).toThrow()
  })

  it('should sanitize pool setting values in the config', () => {
    testConfigSanitizing('maxConnectionLifetime', 60 * 60 * 1000)
    testConfigSanitizing('maxConnectionPoolSize', DEFAULT_MAX_SIZE)
    testConfigSanitizing(
      'connectionAcquisitionTimeout',
      DEFAULT_ACQUISITION_TIMEOUT
    )
  })

  it('should discard closed connections', done => {
    driver = neo4j.driver('bolt://localhost', sharedNeo4j.authToken)

    const session1 = driver.session()
    session1.run('CREATE () RETURN 42').then(() => {
      session1.close()

      // one connection should be established
      const connections1 = openConnectionFrom(driver)
      expect(connections1.length).toEqual(1)

      // close/break existing pooled connection
      connections1.forEach(connection => connection.close())

      const session2 = driver.session()
      session2.run('RETURN 1').then(() => {
        session2.close()

        // existing connection should be disposed and new one should be created
        const connections2 = openConnectionFrom(driver)
        expect(connections2.length).toEqual(1)

        expect(connections1[0]).not.toEqual(connections2[0])

        done()
      })
    })
  })

  it('should discard old connections', async () => {
    const maxLifetime = 100000
    driver = neo4j.driver('bolt://localhost', sharedNeo4j.authToken, {
      maxConnectionLifetime: maxLifetime
    })

    const session1 = driver.session()
    await session1.run('CREATE () RETURN 42')
    session1.close()

    // one connection should be established
    const connections1 = openConnectionFrom(driver)
    expect(connections1.length).toEqual(1)

    // make existing connection look very old by advancing the `Date.now()` value
    const currentTime = Date.now()
    const clock = lolex.install()
    try {
      clock.setSystemTime(currentTime + maxLifetime * 2)

      const session2 = driver.session()
      await session2.run('RETURN 1')
      session2.close()

      // old connection should be disposed and new one should be created
      const connections2 = openConnectionFrom(driver)
      expect(connections2.length).toEqual(1)

      expect(connections1[0]).not.toEqual(connections2[0])
    } finally {
      clock.uninstall()
    }
  })

  const exposedTypes = [
    'Node',
    'Path',
    'PathSegment',
    'Record',
    'Relationship',
    'Result',
    'ResultSummary',
    'UnboundRelationship'
  ]

  exposedTypes.forEach(type => {
    it(`should expose type ${type}`, () => {
      expect(undefined === neo4j.types[type]).toBe(false)
    })
  })

  it('should connect to IPv6 address without port', done => {
    testIPv6Connection('bolt://[::1]', done)
  })

  it('should connect to IPv6 address with port', done => {
    testIPv6Connection('bolt://[::1]:7687', done)
  })

  const nativeNumbers = [
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    -0,
    0,
    -42,
    42,
    -999,
    999,
    -1000,
    1000,
    -9000000,
    9000000,
    Number.MIN_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER - 1
  ]

  nativeNumbers.forEach(number => {
    it(`should return native number ${number} when disableLosslessIntegers=true`, done => {
      testNumberInReturnedRecord(number, number, done)
    })
  })

  const integersWithNativeNumberEquivalent = [
    [neo4j.int(0), 0],
    [neo4j.int(42), 42],
    [neo4j.int(-100), -100],
    [neo4j.int(Number.MIN_SAFE_INTEGER), Number.MIN_SAFE_INTEGER],
    [neo4j.int(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    [neo4j.int('-9007199254740992'), Number.NEGATIVE_INFINITY], // Number.MIN_SAFE_INTEGER - 1
    [neo4j.int('9007199254740992'), Number.POSITIVE_INFINITY], // Number.MAX_SAFE_INTEGER + 1
    [neo4j.int('-9007199254749999'), Number.NEGATIVE_INFINITY], // Number.MIN_SAFE_INTEGER - 9007
    [neo4j.int('9007199254749999'), Number.POSITIVE_INFINITY] // Number.MAX_SAFE_INTEGER + 9008
  ]

  integersWithNativeNumberEquivalent.forEach(integerWithNativeNumber => {
    const integer = integerWithNativeNumber[0]
    const nativeNumber = integerWithNativeNumber[1]

    it(`should send Integer ${integer.toString()} and return native number ${nativeNumber} when disableLosslessIntegers=true`, done => {
      testNumberInReturnedRecord(integer, nativeNumber, done)
    })
  })

  function testIPv6Connection (url, done) {
    driver = neo4j.driver(url, sharedNeo4j.authToken)

    const session = driver.session()
    session.run('RETURN 42').then(result => {
      expect(result.records[0].get(0).toNumber()).toEqual(42)
      session.close()
      done()
    })
  }

  function testNumberInReturnedRecord (inputNumber, expectedNumber, done) {
    driver = neo4j.driver('bolt://localhost', sharedNeo4j.authToken, {
      disableLosslessIntegers: true
    })

    const session = driver.session()
    session
      .run('RETURN $number AS n0, $number AS n1', { number: inputNumber })
      .then(result => {
        session.close()

        const records = result.records
        expect(records.length).toEqual(1)
        const record = records[0]

        expect(record.get('n0')).toEqual(expectedNumber)
        expect(record.get('n1')).toEqual(expectedNumber)

        expect(record.get(0)).toEqual(expectedNumber)
        expect(record.get(1)).toEqual(expectedNumber)

        expect(record.toObject()).toEqual({
          n0: expectedNumber,
          n1: expectedNumber
        })

        done()
      })
  }

  /**
   * Starts new transaction to force new network connection.
   * @param {Driver} driver - the driver to use.
   */
  function startNewTransaction (driver) {
    const session = driver.session()
    expect(session.beginTransaction()).toBeDefined()
  }

  function wrongCredentials () {
    return neo4j.auth.basic('neo4j', 'who would use such a password')
  }

  function testConfigSanitizing (configProperty, defaultValue) {
    validateConfigSanitizing({}, defaultValue)
    validateConfigSanitizing({ [configProperty]: 42 }, 42)
    validateConfigSanitizing({ [configProperty]: 0 }, 0)
    validateConfigSanitizing({ [configProperty]: '42' }, 42)
    validateConfigSanitizing({ [configProperty]: '042' }, 42)
    validateConfigSanitizing({ [configProperty]: -42 }, Number.MAX_SAFE_INTEGER)
  }

  function validateConfigSanitizing (config, configProperty, expectedValue) {
    const driver = neo4j.driver(
      'bolt://localhost',
      sharedNeo4j.authToken,
      config
    )
    try {
      expect(driver._config[configProperty]).toEqual(expectedValue)
    } finally {
      driver.close()
    }
  }

  function openConnectionFrom (driver) {
    return Array.from(
      Object.values(driver._connectionProvider._openConnections)
    )
  }

  function routingProcedureOnlyAvailableOnCores () {
    return serverVersion.compareTo(VERSION_4_0_0) < 0
  }
})
