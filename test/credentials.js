const GCM_SENDER_ID = process.env.GCM_SENDER_ID || '976529667804';

module.exports = {
  // Rust+ app's FCM sender ID (retrieved from environment variable or using default)
  senderId: GCM_SENDER_ID,
  
  // First client credentials
  client1: {
    steamId: '76561198443856123',
    androidId: '5048663660435853576',    
    securityToken: '663427715329442114',  
  },
  
  // Second client credentials
  client2: {
    steamId: '76561198060371965',
    androidId: '5252798276494791548',      
    securityToken: '8043242506367223078',   
  }
};
