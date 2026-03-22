const EventEmitter = require('events');
const Long = require('long');
const Parser = require('./parser');
const decrypt = require('./utils/decrypt');
const path = require('path');
const tls = require('tls');
const { checkIn } = require('./gcm');
const {
  kMCSVersion,
  kLoginRequestTag,
  kDataMessageStanzaTag,
  kLoginResponseTag,
} = require('./constants');
const { load } = require('protobufjs');

const HOST = 'mtalk.google.com';
const PORT = 5228;
const MAX_RETRY_TIMEOUT = 15;


module.exports = class Client extends EventEmitter {
  constructor(androidId, securityToken, persistentIds, steamId = null) {
    super();
    this._androidId = androidId;
    this._securityToken = securityToken;
    this._persistentIds = persistentIds || [];
    this._steamId = steamId;
    this._retryCount = 0;
    this._proto = null;
    this._protoPromise = null;
    this._isDestroyed = false;

    this._onSocketConnect = this._onSocketConnect.bind(this);
    this._onSocketClose = this._onSocketClose.bind(this);
    this._onSocketError = this._onSocketError.bind(this);
    this._onMessage = this._onMessage.bind(this);
    this._onParserError = this._onParserError.bind(this);
  }

  async _initProto() {
    if (!this._protoPromise) {
      this._protoPromise = load(path.resolve(__dirname, 'mcs.proto'));
    }
    this._proto = await this._protoPromise;
  }

  async connect() {
    if (this._isDestroyed) {
      throw new Error('Cannot connect a destroyed client');
    }

    await this._initProto();
    await this._checkIn();
    this._connect();

    if (!this._socket) {
      return;
    }

    this._parser = new Parser(this._socket, this._proto);
    this._parser.on('message', this._onMessage);
    this._parser.on('error', this._onParserError);
  }

  destroy() {
    this._isDestroyed = true;
    this._destroy();
    this.removeAllListeners();
  }

  disconnect() {
    if (this._socket) {
      try {
        this._socket.end();
      } catch (error) {
        this._destroy();
      }
    }
  }

  reconnect() {
    if (this._isDestroyed) {
      return;
    }

    this._destroy();
    this._retryCount = 0;

    this.connect().catch(err => {
      if (this._isDestroyed) return;
      this._retry();
    });
  }

  getPersistentIds() {
    return [...this._persistentIds];
  }

  setPersistentIds(ids) {
    if (!Array.isArray(ids)) {
      throw new Error('PersistentIds must be an array');
    }
    this._persistentIds = [...ids];
  }

  isConnected() {
    return this._socket !== null &&
           !this._isDestroyed &&
           this._socket.connecting === false &&
           this._socket.destroyed === false;
  }

  async _checkIn() {
    return checkIn(
      this._androidId,
      this._securityToken,
    );
  }

  _connect() {
    const secureContext = tls.createSecureContext();
    const options = {
      host: HOST,
      port: PORT,
      servername: HOST,
      keepAlive: true,
      secureContext: secureContext,
    };

    this._socket = tls.connect(options, () => {
      this._socket.write(this._loginBuffer());
      this._onSocketConnect();
    });

    this._socket.on('close', this._onSocketClose);
    this._socket.on('error', this._onSocketError);
  }

  _destroy() {
    if (this._retryTimeout) {
      clearTimeout(this._retryTimeout);
      this._retryTimeout = null;
    }

    if (this._socket) {
      this._socket.removeListener('connect', this._onSocketConnect);
      this._socket.removeListener('close', this._onSocketClose);
      this._socket.removeListener('error', this._onSocketError);

      try {
        this._socket.destroy();
      } catch (error) {
        // ignore
      }

      this._socket = null;
    }

    if (this._parser) {
      this._parser.removeListener('message', this._onMessage);
      this._parser.removeListener('error', this._onParserError);

      try {
        this._parser.destroy();
      } catch (error) {
        // ignore
      }

      this._parser = null;
    }
  }

  _loginBuffer() {
    const LoginRequestType = this._proto.lookupType('mcs_proto.LoginRequest');
    const hexAndroidId = Long.fromString(
      this._androidId
    ).toString(16);
    const loginRequest = {
      adaptiveHeartbeat    : false,
      authService          : 2,
      authToken            : this._securityToken,
      id                   : 'chrome-63.0.3234.0',
      domain               : 'mcs.android.com',
      deviceId             : `android-${hexAndroidId}`,
      networkType          : 1,
      resource             : this._androidId,
      user                 : this._androidId,
      useRmq2              : true,
      setting              : [{ name : 'new_vc', value : '1' }],
      // Id of the last notification received
      clientEvent          : [],
      receivedPersistentId : this._persistentIds,
    };

    const errorMessage = LoginRequestType.verify(loginRequest);
    if (errorMessage) {
      throw new Error(errorMessage);
    }

    const buffer = LoginRequestType.encodeDelimited(loginRequest).finish();

    return Buffer.concat([
      Buffer.from([kMCSVersion, kLoginRequestTag]),
      buffer,
    ]);
  }

  _onSocketConnect() {
    this._retryCount = 0;
    this.emit('connect');
  }

  _onSocketClose() {
    this.emit('disconnect');
    this._retry();
  }

  _onSocketError(error) {
    // ignore, the close handler takes care of retry
  }

  _onParserError(error) {
    this._retry();
  }

  _retry() {
    if (this._isDestroyed) {
      return;
    }

    this._destroy();

    const jitter = Math.floor(Math.random() * 1000);
    const baseTimeout = Math.min(++this._retryCount, MAX_RETRY_TIMEOUT) * 1000;
    const timeout = baseTimeout + jitter;

    this._retryTimeout = setTimeout(() => {
      if (this._isDestroyed) return;

      this.connect().catch(err => {
        if (this._isDestroyed) return;
        this._retry();
      });
    }, timeout);
  }

  _onMessage({ tag, object }) {
    if (tag === kLoginResponseTag) {
      // clear persistent ids, as we just sent them to the server while logging in
      this._persistentIds = [];
    } else if (tag === kDataMessageStanzaTag) {
      this._onDataMessage(object);
    }
  }

  _onDataMessage(object) {
    if (this._persistentIds.includes(object.persistentId)) {
      return;
    }

    const bodyData = this._extractBodyData(object);
    if (bodyData && bodyData.playerId) {
      if (this._steamId && bodyData.playerId !== this._steamId) {
        return;
      }
    }

    if (!this._hasEncryptionInfo(object)) {
      this._persistentIds.push(object.persistentId);
      this.emit('ON_DATA_RECEIVED', object);
      return;
    }

    try {
      const decryptionInfo = this._getDecryptionInfo(object);

      if (!decryptionInfo) {
        throw new Error('Missing encryption information');
      }

      const message = decrypt(object, decryptionInfo);

      this._persistentIds.push(object.persistentId);
      this.emit('ON_NOTIFICATION_RECEIVED', {
        notification: message,
        persistentId: object.persistentId,
        object: object,
      });
    } catch (error) {
      switch (true) {
        case error.message.includes(
          'Unsupported state or unable to authenticate data'
        ):
        case error.message.includes('crypto-key is missing'):
        case error.message.includes('salt is missing'):
        case error.message.includes('Missing encryption information'):
          console.warn(
            'Message dropped as it could not be decrypted: ' + error.message
          );
          this._persistentIds.push(object.persistentId);
          return;
        default: {
          throw error;
        }
      }
    }
  }

  _extractBodyData(object) {
    try {
      const bodyItem = object.appData.find(item => item.key === "body");
      if (bodyItem && bodyItem.value) {
        return JSON.parse(bodyItem.value);
      }
    } catch (error) {
      // ignore
    }
    return null;
  }

  _hasEncryptionInfo(object) {
    return object.appData && Array.isArray(object.appData) &&
           object.appData.some(item => item.key === "crypto-key");
  }

  _getDecryptionInfo(object) {
    const cryptoKeyItem = object.appData.find(item => item.key === "crypto-key");
    const saltItem = object.appData.find(item => item.key === "encryption");

    if (!cryptoKeyItem || !saltItem) {
      return null;
    }

    return {
      key: cryptoKeyItem.value,
      salt: saltItem.value
    };
  }
};
