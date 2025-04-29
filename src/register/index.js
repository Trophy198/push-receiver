const uuidv4 = require('uuid/v4');
const { register: registerGCM } = require('../gcm');
const registerFCM = require('../fcm');

module.exports = register;

/**
 * Register a new device with FCM
 * @param {string} senderId - The sender ID to register with
 * @param {string} [clientId] - Optional client identifier for logging
 * @returns {Promise<Object>} Registration information
 */
async function register(senderId, clientId = 'unknown') {
  console.log(`[Register ${clientId}] Starting registration process with sender ID: ${senderId}`);
  
  try {
    // Should be unique by app - One GCM registration/token by app/appId
    const appId = `wp:receiver.push.com#${uuidv4()}`;
    console.log(`[Register ${clientId}] Generated app ID: ${appId}`);
    
    console.log(`[Register ${clientId}] Registering with GCM...`);
    const subscription = await registerGCM(appId);
    console.log(`[Register ${clientId}] GCM registration successful, token: ${subscription.token.substr(0, 8)}...`);
    
    console.log(`[Register ${clientId}] Registering with FCM...`);
    const result = await registerFCM({
      token: subscription.token,
      senderId,
      appId,
    });
    console.log(`[Register ${clientId}] FCM registration successful`);
    
    // Need to be saved by the client
    const registrationInfo = Object.assign({}, result, { gcm: subscription });
    
    console.log(`[Register ${clientId}] Registration process completed successfully`);
    console.log(`[Register ${clientId}] Android ID: ${registrationInfo.androidId}`);
    console.log(`[Register ${clientId}] Security Token: ${registrationInfo.securityToken.substr(0, 8)}...`);
    
    return registrationInfo;
  } catch (error) {
    console.error(`[Register ${clientId}] Registration failed:`, error.message);
    throw new Error(`FCM registration failed: ${error.message}`);
  }
}
