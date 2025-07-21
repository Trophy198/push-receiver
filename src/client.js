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
    // 테스트 - 스팀 아이디를 생성자에서 받아보기
    this._steamId = steamId;
    this._retryCount = 0;
    this._proto = null;
    this._isDestroyed = false;
    this._clientId = `${androidId.substr(-8)}`;
    
    this._onSocketConnect = this._onSocketConnect.bind(this);
    this._onSocketClose = this._onSocketClose.bind(this);
    this._onSocketError = this._onSocketError.bind(this);
    this._onMessage = this._onMessage.bind(this);
    this._onParserError = this._onParserError.bind(this);
    
    console.log(`[Client ${this._clientId}] Created new FCM client instance`);
  }
  
  async _initProto() {
    if (!this._proto) {
      console.log(`[Client ${this._clientId}] Loading proto definition`);
      this._proto = await load(path.resolve(__dirname, 'mcs.proto'));
    }
  }
  
  async connect() {
    if (this._isDestroyed) {
      throw new Error('Cannot connect a destroyed client');
    }
    
    console.log(`[Client ${this._clientId}] Starting connection process`);
    await this._initProto();
    
    try {
      console.log(`[Client ${this._clientId}] Performing check-in`);
      await this._checkIn();
    } catch (error) {
      console.error(`[Client ${this._clientId}] Check-in failed:`, error.message);
      throw new Error(`FCM check-in failed: ${error.message}`);
    }
    
    this._connect();
    
    if (!this._socket) {
      console.warn(`[Client ${this._clientId}] Socket closed immediately after creation`);
      return;
    }
    
    try {
      console.log(`[Client ${this._clientId}] Initializing parser`);
      await Parser.init();
    } catch (error) {
      console.error(`[Client ${this._clientId}] Parser initialization failed:`, error.message);
      this._destroy();
      throw new Error(`Parser initialization failed: ${error.message}`);
    }
    
    if (!this._socket) {
      console.warn(`[Client ${this._clientId}] Socket closed during parser initialization`);
      return;
    }
    
    this._parser = new Parser(this._socket);
    this._parser.on('message', this._onMessage);
    this._parser.on('error', this._onParserError);
    
    console.log(`[Client ${this._clientId}] Connection setup completed`);
  }
  
  destroy() {
    console.log(`[Client ${this._clientId}] Client destruction requested`);
    
    this._isDestroyed = true;
    
    this._destroy();
    
    this.removeAllListeners();
    
    console.log(`[Client ${this._clientId}] Client destroyed`);
  }
  
  disconnect() {
    console.log(`[Client ${this._clientId}] Manual disconnect requested`);
    
    if (this._socket) {
      try {
        this._socket.end();
      } catch (error) {
        console.warn(`[Client ${this._clientId}] Error during disconnect:`, error.message);
        this._destroy();
      }
    } else {
      console.log(`[Client ${this._clientId}] No active socket to disconnect`);
    }
  }
  
  reconnect() {
    console.log(`[Client ${this._clientId}] Manual reconnect requested`);
    
    if (this._isDestroyed) {
      console.warn(`[Client ${this._clientId}] Cannot reconnect destroyed client`);
      return;
    }
    
    this._destroy();
    
    this._retryCount = 0;
    
    console.log(`[Client ${this._clientId}] Initiating immediate reconnection`);
    this.connect().catch(err => {
      if (this._isDestroyed) return;
      
      console.error(`[Client ${this._clientId}] Manual reconnect failed:`, err.message);
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
    console.log(`[Client ${this._clientId}] Setting ${ids.length} persistentIds`);
    this._persistentIds = [...ids];
  }
  
  isConnected() {
    return this._socket !== null && 
           !this._isDestroyed && 
           this._socket.connecting === false && 
           this._socket.destroyed === false;
  }
  
  // 체크인 메소드
  async _checkIn() {
    return checkIn(
      this._androidId,
      this._securityToken,
    );
  }
  
  // TLS 소켓 생성 방식 개선
  _connect() {
    const options = {
      host: HOST, 
      port: PORT,
      // androidId를 세션 ID로 계속 사용 (내부 식별용)
      session: Buffer.from(this._androidId),
      // servername을 올바른 서버 이름으로 변경
      servername: HOST, // 'mtalk.google.com'
      keepAlive: true
    };
    
    console.log(`[Client ${this._clientId}] Connecting to FCM`);
    
    this._socket = tls.connect(options, () => {
      console.log(`[Client ${this._clientId}] TLS connection established`);
      // TLS 연결이 수립된 후에 로그인 버퍼 전송
      this._socket.write(this._loginBuffer());
      this._onSocketConnect();
    });
    
    this._socket.on('close', this._onSocketClose);
    this._socket.on('error', this._onSocketError);
  }
  
  // 리소스 정리 메소드 개선
  _destroy() {
    console.log(`[Client ${this._clientId}] Destroying current connection`);
    
    if (this._retryTimeout) {
      clearTimeout(this._retryTimeout);
      this._retryTimeout = null;
    }
    
    if (this._socket) {
      console.log(`[Client ${this._clientId}] Cleaning up socket`);
      this._socket.removeListener('connect', this._onSocketConnect);
      this._socket.removeListener('close', this._onSocketClose);
      this._socket.removeListener('error', this._onSocketError);
      
      try {
        this._socket.destroy();
      } catch (error) {
        console.warn(`[Client ${this._clientId}] Error while destroying socket:`, error.message);
      }
      
      this._socket = null;
    }
    
    if (this._parser) {
      console.log(`[Client ${this._clientId}] Cleaning up parser`);
      this._parser.removeListener('message', this._onMessage);
      this._parser.removeListener('error', this._onParserError);
      
      try {
        this._parser.destroy();
      } catch (error) {
        console.warn(`[Client ${this._clientId}] Error while destroying parser:`, error.message);
      }
      
      this._parser = null;
    }
  }
  
  // 로그인 버퍼 생성 메소드 개선
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
  
  // 소켓 이벤트 핸들러 개선
  _onSocketConnect() {
    console.log(`[Client ${this._clientId}] Socket connected`);
    this._retryCount = 0; // 연결 성공 시 재시도 카운터 초기화
    this.emit('connect');
  }

  _onSocketClose() {
    console.log(`[Client ${this._clientId}] Socket closed`);
    this.emit('disconnect');
    this._retry();
  }

  _onSocketError(error) {
    console.error(`[Client ${this._clientId}] Socket error:`, error.message);
    // 소켓 오류 이벤트 발생 시 특별한 처리가 필요하지 않음
    // close 이벤트가 이어서 발생하므로 _onSocketClose에서 재연결 처리
  }
  
  // 파서 오류 핸들러 개선
  _onParserError(error) {
    console.error(`[Client ${this._clientId}] Parser error:`, error.message);
    this._retry();
  }
  
  // 재연결 시도 메소드 개선
  _retry() {
    // 클라이언트가 의도적으로 파괴된 경우 재연결 시도하지 않음
    if (this._isDestroyed) {
      console.log(`[Client ${this._clientId}] Not retrying connection for destroyed client`);
      return;
    }
    
    this._destroy();
    
    // 클라이언트별로 다른 재연결 시간 적용
    const jitter = Math.floor(Math.random() * 1000); // 0-999ms의 무작위 지연
    const baseTimeout = Math.min(++this._retryCount, MAX_RETRY_TIMEOUT) * 1000;
    const timeout = baseTimeout + jitter;
    
    console.log(`[Client ${this._clientId}] Scheduling reconnect in ${timeout}ms (attempt #${this._retryCount})`);
    
    this._retryTimeout = setTimeout(() => {
      if (this._isDestroyed) return; // 타이머 실행 전에 다시 확인
      
      console.log(`[Client ${this._clientId}] Attempting reconnection`);
      this.connect().catch(err => {
        if (this._isDestroyed) return; // 연결 중에 파괴되었는지 확인
        
        console.error(`[Client ${this._clientId}] Reconnect failed:`, err.message);
        this._retry();
      });
    }, timeout);
  }
  
  // 메시지 처리 메소드 개선
  _onMessage({ tag, object }) {
    console.log(`[Client ${this._clientId}] Received message with tag: ${tag}`);
    
    if (tag === kLoginResponseTag) {
      console.log(`[Client ${this._clientId}] Received login response`);
      // 로그인 시 persistentIds 초기화
      this._persistentIds = [];
    } else if (tag === kDataMessageStanzaTag) {
      console.log(`[Client ${this._clientId}] Received data message stanza`);
      this._onDataMessage(object);
    } else {
      console.log(`[Client ${this._clientId}] Received unknown message tag: ${tag}`);
    }
  }
  
  // 데이터 메시지 처리 메소드 개선
  _onDataMessage(object) {
    console.log(`[Client ${this._clientId}] Received data message: ${object.persistentId}`);
    
    // 이미 처리한 메시지인지 확인
    if (this._persistentIds.includes(object.persistentId)) {
      console.log(`[Client ${this._clientId}] Ignoring already processed message: ${object.persistentId}`);
      return;
    }

  // 메시지의 body 정보 추출 (디버깅 목적으로 유지)
  const bodyData = this._extractBodyData(object);
  if (bodyData && bodyData.playerId) {
    // 메시지 대상 정보 로깅만 하고 필터링은 하지 않음
    console.log(`[Client ${this._clientId}] Message target playerId: ${bodyData.playerId}`);

      // 임시 수정 - playerId가 클라이언트의 androidId와 다르면 무시
      if (this._steamId && bodyData.playerId !== this._steamId) {
        console.log(`[Client ${this._clientId}] Ignoring message for another player`);
        return;
      }
  }

    // 암호화되지 않은 메시지 처리
    if (!this._hasEncryptionInfo(object)) {
      console.log(`[Client ${this._clientId}] Processing unencrypted message`);
      this._persistentIds.push(object.persistentId);
      this.emit('ON_DATA_RECEIVED', object);
      return;
    }

    // 암호화된 메시지 처리
    try {
      console.log(`[Client ${this._clientId}] Attempting to decrypt message`);
      const decryptionInfo = this._getDecryptionInfo(object);
      
      if (!decryptionInfo) {
        throw new Error('Missing encryption information');
      }
      
      const message = decrypt(object, decryptionInfo);
      
      // 성공적으로 복호화된 메시지 처리
      this._persistentIds.push(object.persistentId);
      this.emit('ON_NOTIFICATION_RECEIVED', {
        notification: message,
        persistentId: object.persistentId,
        object: object,
      });
    } catch (error) {
      console.error(`[Client ${this._clientId}] Decryption error:`, error.message);
      
      // 기존 에러 처리 로직 (특정 에러는 무시하고 persistentId 추가)
      if (
        error.message.includes('Unsupported state or unable to authenticate data') ||
        error.message.includes('crypto-key is missing') ||
        error.message.includes('salt is missing') ||
        error.message.includes('Missing encryption information')
      ) {
        console.warn(`[Client ${this._clientId}] Message dropped as it could not be decrypted: ${error.message}`);
        this._persistentIds.push(object.persistentId);
        return;
      }
      
      // 그 외 에러는 재throw
      throw error;
    }
  }
  
  // 헬퍼 메소드들 추가
  _extractBodyData(object) {
    try {
      const bodyItem = object.appData.find(item => item.key === "body");
      if (bodyItem && bodyItem.value) {
        return JSON.parse(bodyItem.value);
      }
    } catch (error) {
      console.warn(`[Client ${this._clientId}] Failed to parse body data:`, error.message);
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
