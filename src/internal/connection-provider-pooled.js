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

import ChannelConnection from './connection-channel'
import Pool from './pool'
import PoolConfig from './pool-config'
import ConnectionErrorHandler from './connection-error-handler'
import { SERVICE_UNAVAILABLE } from '../error'
import ConnectionProvider from './connection-provider'

export default class PooledConnectionProvider extends ConnectionProvider {
  constructor ({ id, config, log, userAgent, authToken }) {
    super()

    this._id = id
    this._config = config
    this._log = log
    this._userAgent = userAgent
    this._authToken = authToken
    this._connectionPool = new Pool({
      create: this._createConnection.bind(this),
      destroy: this._destroyConnection.bind(this),
      validate: this._validateConnection.bind(this),
      installIdleObserver: PooledConnectionProvider._installIdleObserverOnConnection.bind(
        this
      ),
      removeIdleObserver: PooledConnectionProvider._removeIdleObserverOnConnection.bind(
        this
      ),
      config: PoolConfig.fromDriverConfig(config),
      log: this._log
    })
    this._openConnections = {}
  }

  _createConnectionErrorHandler () {
    return new ConnectionErrorHandler(SERVICE_UNAVAILABLE)
  }

  /**
   * Create a new connection and initialize it.
   * @return {Promise<Connection>} promise resolved with a new connection or rejected when failed to connect.
   * @access private
   */
  _createConnection (address, release) {
    const connection = ChannelConnection.create(
      address,
      this._config,
      this._createConnectionErrorHandler(),
      this._log
    )
    connection._release = () => release(address, connection)
    this._openConnections[connection.id] = connection

    return connection.connect(this._userAgent, this._authToken).catch(error => {
      // let's destroy this connection
      this._destroyConnection(connection)
      // propagate the error because connection failed to connect / initialize
      throw error
    })
  }

  /**
   * Check that a connection is usable
   * @return {boolean} true if the connection is open
   * @access private
   **/
  _validateConnection (conn) {
    if (!conn.isOpen()) {
      return false
    }

    const maxConnectionLifetime = this._config.maxConnectionLifetime
    const lifetime = Date.now() - conn.creationTimestamp
    return lifetime <= maxConnectionLifetime
  }

  /**
   * Dispose of a connection.
   * @return {Connection} the connection to dispose.
   * @access private
   */
  _destroyConnection (conn) {
    delete this._openConnections[conn.id]
    conn.close()
  }

  close () {
    try {
      // purge all idle connections in the connection pool
      this._connectionPool.purgeAll()
    } finally {
      // then close all connections driver has ever created
      // it is needed to close connections that are active right now and are acquired from the pool
      for (let connectionId in this._openConnections) {
        if (this._openConnections.hasOwnProperty(connectionId)) {
          this._openConnections[connectionId].close()
        }
      }
    }
  }

  static _installIdleObserverOnConnection (conn, observer) {
    conn._queueObserver(observer)
  }

  static _removeIdleObserverOnConnection (conn) {
    conn._updateCurrentObserver()
  }
}
