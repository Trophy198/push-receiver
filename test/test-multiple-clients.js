/**
 * Test script for the improved push-receiver library
 * This script tests multiple FCM client instances to ensure they work correctly
 * and do not interfere with each other (resolving the original issue).
 */

const PushReceiverClient = require('../src/client');
const credentials = require('./credentials');
const fs = require('fs');
const path = require('path');

// Configuration
const TEST_DURATION = 60000; // Run test for 1 minute
const RECONNECT_INTERVAL = 15000; // Reconnect every 15 seconds
const LOG_FILE = path.join(__dirname, '..', `test_results_${Date.now()}.log`);

// Logger class for both console and file output
class Logger {
  constructor(logFilePath) {
    this.logFilePath = logFilePath;
    this.logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
    
    // Save original console methods
    this._originalLog = console.log;
    this._originalError = console.error;
    this._originalWarn = console.warn;
    this._originalInfo = console.info;
    
    // Override console methods
    console.log = this.log.bind(this);
    console.error = this.error.bind(this);
    console.warn = this.warn.bind(this);
    console.info = this.info.bind(this);
    
    this.log(`Logger initialized. Logging to file: ${logFilePath}`);
  }
  
  _getTimestamp() {
    return new Date().toISOString();
  }
  
  _formatMessage(level, ...args) {
    const timestamp = this._getTimestamp();
    const prefix = `[${timestamp}] [${level}]`;
    
    // Convert arguments to strings
    const messages = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return String(arg);
        }
      }
      return String(arg);
    });
    
    return `${prefix} ${messages.join(' ')}`;
  }
  
  log(...args) {
    const formattedMessage = this._formatMessage('INFO', ...args);
    
    // Write to file
    this.logStream.write(formattedMessage + '\n');
    
    // Write to console
    this._originalLog(...args);
  }
  
  error(...args) {
    const formattedMessage = this._formatMessage('ERROR', ...args);
    
    // Write to file
    this.logStream.write(formattedMessage + '\n');
    
    // Write to console
    this._originalError(...args);
  }
  
  warn(...args) {
    const formattedMessage = this._formatMessage('WARN', ...args);
    
    // Write to file
    this.logStream.write(formattedMessage + '\n');
    
    // Write to console
    this._originalWarn(...args);
  }
  
  info(...args) {
    const formattedMessage = this._formatMessage('INFO', ...args);
    
    // Write to file
    this.logStream.write(formattedMessage + '\n');
    
    // Write to console
    this._originalInfo(...args);
  }
  
  close() {
    this.logStream.end();
    
    // Restore original console methods
    console.log = this._originalLog;
    console.error = this._originalError;
    console.warn = this._originalWarn;
    console.info = this._originalInfo;
    
    this._originalLog(`Logger closed. Log file: ${this.logFilePath}`);
  }
}

// Initialize logger
const logger = new Logger(LOG_FILE);

// Test state
const clients = new Map(); // steamId -> client instance
const eventCounts = new Map(); // steamId -> {connect, disconnect, message}
let testRunning = true;

// Initialize counter for a client
function initCounter(steamId) {
  eventCounts.set(steamId, {
    connect: 0,
    disconnect: 0,
    message: 0,
    error: 0
  });
}

// Create and connect a client
async function setupClient(credentials) {
  const { steamId, androidId, securityToken } = credentials;
  console.log(`\n[Test] Setting up client for SteamID: ${steamId}`);
  
  try {
    // Create client instance
    const client = new PushReceiverClient(androidId, securityToken, [], steamId);
    clients.set(steamId, client);
    initCounter(steamId);
    
    // Set up event handlers
    client.on('connect', () => {
      const counts = eventCounts.get(steamId);
      counts.connect++;
      console.log(`[${steamId}] Connection established (${counts.connect} times)`);
      console.log(`[${steamId}] Client connected status: ${client.isConnected()}`);
    });
    
    client.on('disconnect', () => {
      const counts = eventCounts.get(steamId);
      counts.disconnect++;
      console.log(`[${steamId}] Connection closed (${counts.disconnect} times)`);
      console.log(`[${steamId}] Client connected status: ${client.isConnected()}`);
    });
    
    client.on('ON_DATA_RECEIVED', (data) => {
      const counts = eventCounts.get(steamId);
      counts.message++;
      console.log(`[${steamId}] Received message: ${data.persistentId}`);
      console.log(`[${steamId}] Message body:`, JSON.stringify(data).substring(0, 100) + '...');
    });
    
    // Connect
    console.log(`[${steamId}] Connecting client...`);
    await client.connect();
    console.log(`[${steamId}] Client setup complete`);
    
    return client;
  } catch (error) {
    console.error(`[${steamId}] Setup failed:`, error.message);
    const counts = eventCounts.get(steamId);
    if (counts) counts.error++;
    throw error;
  }
}

// Test message routing with a mock message
function testMessageRouting() {
  console.log('\n[Test] Testing message routing with mock messages');
  
  // Create mock message for first client (playerId = steamId for filtering)
  const mockMessage1 = createMockMessage(
    credentials.client1.steamId,
    credentials.client1.steamId,
    credentials.senderId
  );

  // Create mock message for second client (playerId = steamId for filtering)
  const mockMessage2 = createMockMessage(
    credentials.client2.steamId,
    credentials.client2.steamId,
    credentials.senderId
  );
  
  // Get client instances
  const client1 = clients.get(credentials.client1.steamId);
  const client2 = clients.get(credentials.client2.steamId);
  
  if (!client1 || !client2) {
    console.error('[Test] Cannot test message routing, clients not properly set up');
    return;
  }
  
  console.log('[Test] Sending mock message 1 to client 1');
  // Access private method for testing - this is not ideal but necessary for testing
  // In a real environment, we'd use a proper mock/stub approach
  if (client1._onDataMessage) {
    client1._onDataMessage(mockMessage1);
  }
  
  console.log('[Test] Sending mock message 1 to client 2 (should be ignored)');
  if (client2._onDataMessage) {
    client2._onDataMessage(mockMessage1);
  }
  
  console.log('[Test] Sending mock message 2 to client 2');
  if (client2._onDataMessage) {
    client2._onDataMessage(mockMessage2);
  }
  
  console.log('[Test] Sending mock message 2 to client 1 (should be ignored)');
  if (client1._onDataMessage) {
    client1._onDataMessage(mockMessage2);
  }
  
  console.log('[Test] Message routing test complete');
}

// Create a mock FCM message
function createMockMessage(steamId, playerId, senderId) {
  return {
    id: `TEST-${Date.now()}`,
    from: senderId,
    category: 'com.facepunch.rust.companion',
    token: 'com.facepunch.rust.companion',
    persistentId: `test-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
    ttl: 2419200,
    sent: Date.now().toString(),
    appData: [
      { key: 'google.c.sender.id', value: senderId },
      { key: 'gcm.notification.title', value: 'Test Server' },
      { key: 'title', value: 'Test Server' },
      { 
        key: 'body', 
        value: JSON.stringify({
          id: `test-server-${Date.now()}`,
          name: 'Test Server',
          desc: 'Test server for push-receiver',
          img: 'http://example.com/image.jpg',
          logo: '',
          url: 'https://example.com',
          ip: '127.0.0.1',
          port: '28083',
          playerId: playerId,
          playerToken: '123456',
          type: 'server'
        })
      },
      { key: 'message', value: 'Test message' },
      { key: 'gcm.notification.body', value: 'Test message' }
    ]
  };
}

// Test reconnection
async function testReconnect(steamId) {
  try {
    const client = clients.get(steamId);
    if (!client || !client.isConnected()) return;
    
    console.log(`[${steamId}] Testing reconnect...`);
    
    // Disconnect
    client.disconnect();
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Reconnect
    await client.reconnect();
    
    console.log(`[${steamId}] Reconnect test complete`);
  } catch (error) {
    console.error(`[${steamId}] Reconnect test failed:`, error.message);
    const counts = eventCounts.get(steamId);
    if (counts) counts.error++;
  }
}

// Print test results
function printResults() {
  console.log('\n========== TEST RESULTS ==========');
  
  for (const [steamId, counts] of eventCounts.entries()) {
    console.log(`\nClient ${steamId}:`);
    console.log(`- Connect events: ${counts.connect}`);
    console.log(`- Disconnect events: ${counts.disconnect}`);
    console.log(`- Messages received: ${counts.message}`);
    console.log(`- Errors encountered: ${counts.error}`);
    
    const client = clients.get(steamId);
    console.log(`- Client connected: ${client ? client.isConnected() : 'Client not found'}`);
  }
  
  console.log('\n==================================');
}

// Clean up all clients
async function cleanup() {
  console.log('\n[Test] Cleaning up all clients');
  
  for (const [steamId, client] of clients.entries()) {
    console.log(`[${steamId}] Destroying client...`);
    client.destroy();
  }
  
  clients.clear();
  console.log('[Test] Cleanup complete');
}

// Main test function
async function runTest() {
  console.log('Starting push-receiver test with multiple clients');
  console.log(`Test will run for ${TEST_DURATION / 1000} seconds`);
  console.log(`Logs are being saved to: ${LOG_FILE}`);
  
  try {
    // Set up clients with a delay between them
    await setupClient(credentials.client1);
    console.log('\n[Test] Waiting 5 seconds before setting up the second client...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    await setupClient(credentials.client2);
    
    // Test message routing
    await new Promise(resolve => setTimeout(resolve, 5000));
    testMessageRouting();
    
    // Set up periodic reconnect tests
    const reconnectInterval = setInterval(() => {
      if (!testRunning) {
        clearInterval(reconnectInterval);
        return;
      }
      
      testReconnect(credentials.client1.steamId)
        .catch(err => console.error('[Test] Reconnect test error:', err));
    }, RECONNECT_INTERVAL);
    
    // End test after the specified duration
    setTimeout(async () => {
      testRunning = false;
      clearInterval(reconnectInterval);
      
      printResults();
      await cleanup();
      
      console.log('\nTest completed!');
      console.log(`Full test log saved to: ${LOG_FILE}`);
      
      // Close logger at the end
      logger.close();
    }, TEST_DURATION);
    
  } catch (error) {
    console.error('[Test] Test failed:', error);
    await cleanup();
    logger.close();
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  console.log('\n[Test] Test interrupted by user');
  testRunning = false;
  await cleanup();
  logger.close();
  process.exit(0);
});

// Run the test
runTest().catch(error => {
  console.error('Unhandled error in test:', error);
  logger.close();
});
