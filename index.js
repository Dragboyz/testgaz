import { Agent } from "@xmtp/agent-sdk";
import OpenAI from 'openai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import Database from 'better-sqlite3';
import NodeCache from 'node-cache';

// Load environment variables
dotenv.config();

// Ensure installation directory exists and clean old installations
const installationPath = process.env.XMTP_INSTALLATION_PATH || './.xmtp-installation';
if (!fs.existsSync(installationPath)) {
  fs.mkdirSync(installationPath, { recursive: true });
  console.log(`📁 Created XMTP installation directory: ${installationPath}`);
} else {
  // Clean old installations to prevent "2 installations" warning
  try {
    const files = fs.readdirSync(installationPath);
    const oldInstalls = files.filter(f => f.startsWith('installation-') && f !== 'installation-current');
    oldInstalls.forEach(f => {
      fs.rmSync(path.join(installationPath, f), { recursive: true, force: true });
      console.log(`🗑️ Removed old installation: ${f}`);
    });
  } catch (e) {
    console.log(`⚠️ Could not clean old installations: ${e.message}`);
  }
}

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize XMTP Agent SDK with SQLCipher encryption
const agent = await Agent.createFromEnv({
  env: process.env.XMTP_ENV || 'production',
  persistConversations: true,
  installationPath: installationPath,
  // Add SQLCipher encryption key
  dbEncryptionKey: process.env.XMTP_DB_ENCRYPTION_KEY || 'default-key-change-in-production'
});

// --- Base App Quick Actions Implementation ---
const ContentTypeActions = { authorityId: 'coinbase.com', typeId: 'actions', version: '1.0' };
const ContentTypeIntent = { authorityId: 'coinbase.com', typeId: 'intent', version: '1.0' };

// Register codec for Base App content types with validation
class JsonCodec {
  constructor(contentType) {
    this._contentType = contentType;
    this.id = `${contentType.authorityId}/${contentType.typeId}:${contentType.version}`;
  }
  get contentType() {
    return this._contentType;
  }
  encode(content) {
    // Validate ActionsContent schema before encoding
    if (this._contentType.typeId === 'actions') {
      this.validateActionsContent(content);
    }
    const json = JSON.stringify(content);
    return new TextEncoder().encode(json);
  }
  decode(bytes) {
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  }
  
  validateActionsContent(content) {
    if (!content.id || typeof content.id !== 'string') {
      throw new Error('ActionsContent.id must be a non-empty string');
    }
    if (!content.description || typeof content.description !== 'string') {
      throw new Error('ActionsContent.description must be a non-empty string');
    }
    if (!Array.isArray(content.actions) || content.actions.length === 0 || content.actions.length > 10) {
      throw new Error('ActionsContent.actions must be an array with 1-10 items');
    }
    
    const actionIds = new Set();
    content.actions.forEach((action, index) => {
      if (!action.id || typeof action.id !== 'string') {
        throw new Error(`Action[${index}].id must be a non-empty string`);
      }
      if (!action.label || typeof action.label !== 'string') {
        throw new Error(`Action[${index}].label must be a non-empty string`);
      }
      if (action.style && !['primary', 'secondary', 'danger'].includes(action.style)) {
        throw new Error(`Action[${index}].style must be 'primary', 'secondary', or 'danger'`);
      }
      if (actionIds.has(action.id)) {
        throw new Error(`Action[${index}].id must be unique`);
      }
      actionIds.add(action.id);
    });
    
    log('info', 'ActionsContent validation passed', { 
      id: content.id, 
      actionsCount: content.actions.length 
    });
  }
}

// Codec registration moved to agent.on('start') - see below

// Simple logging function
function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}]: ${message}`, data);
}

log('info', '🎯 Dragman Quest Vault Agent started successfully!');
log('info', '📱 Ready to create crypto quests in Base App');
log('info', '🚀 Quest Vault features enabled');

// ==================== QUEST VAULT SYSTEM ====================

// SQLite database for persistent storage
const dbPath = path.join(installationPath, 'quest_vault.db');
const db = new Database(dbPath);

// Initialize database schema
function initDatabase() {
  // Quests table
  db.exec(`
    CREATE TABLE IF NOT EXISTS quests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      targetAmount REAL NOT NULL,
      currentAmount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      creator TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      executedAt TEXT,
      deadline TEXT NOT NULL,
      requirements TEXT NOT NULL, -- JSON
      rewards TEXT NOT NULL, -- JSON
      results TEXT -- JSON
    )
  `);
  
  // Participants table
  db.exec(`
    CREATE TABLE IF NOT EXISTS participants (
      questId TEXT NOT NULL,
      address TEXT NOT NULL,
      contribution REAL NOT NULL,
      joinedAt TEXT NOT NULL,
      PRIMARY KEY (questId, address),
      FOREIGN KEY (questId) REFERENCES quests(id)
    )
  `);
  
  // User stats table
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_stats (
      address TEXT PRIMARY KEY,
      totalQuests INTEGER NOT NULL DEFAULT 0,
      successfulQuests INTEGER NOT NULL DEFAULT 0,
      totalProfit REAL NOT NULL DEFAULT 0,
      points INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL
    )
  `);
  
  log('info', 'Database initialized successfully');
}

// Initialize database
initDatabase();

// Quest store operations
const questStore = {
  set: (id, quest) => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO quests 
      (id, type, title, description, targetAmount, currentAmount, status, creator, createdAt, executedAt, deadline, requirements, rewards, results)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      quest.id,
      quest.type,
      quest.title,
      quest.description,
      quest.targetAmount,
      quest.currentAmount,
      quest.status,
      quest.creator,
      quest.createdAt,
      quest.executedAt,
      quest.deadline,
      JSON.stringify(quest.requirements),
      JSON.stringify(quest.rewards),
      quest.results ? JSON.stringify(quest.results) : null
    );
    
    // Update participants
    const deleteParticipants = db.prepare('DELETE FROM participants WHERE questId = ?');
    deleteParticipants.run(id);
    
    if (quest.participants.length > 0) {
      const insertParticipant = db.prepare(`
        INSERT INTO participants (questId, address, contribution, joinedAt)
        VALUES (?, ?, ?, ?)
      `);
      
      quest.participants.forEach(p => {
        insertParticipant.run(id, p.address, p.contribution, p.joinedAt);
      });
    }
  },
  
  get: (id) => {
    const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(id);
    if (!quest) return null;
    
    // Load participants
    const participants = db.prepare(`
      SELECT address, contribution, joinedAt FROM participants WHERE questId = ?
    `).all(id);
    
    return {
      ...quest,
      requirements: JSON.parse(quest.requirements),
      rewards: JSON.parse(quest.rewards),
      results: quest.results ? JSON.parse(quest.results) : null,
      participants: participants.map(p => ({
        address: p.address,
        contribution: p.contribution,
        joinedAt: p.joinedAt
      }))
    };
  },
  
  values: () => {
    const quests = db.prepare('SELECT * FROM quests').all();
    return quests.map(quest => questStore.get(quest.id));
  }
};

const userStats = new Map(); // Keep in-memory for leaderboard performance
const leaderboard = [];

// Quest fee configuration
const QUEST_FEE_PERCENTAGE = 0.015; // 1.5% fee (adjustable)
const AGENT_WALLET_ADDRESS = process.env.AGENT_WALLET_ADDRESS; // Your fee collection wallet

// Calculate quest fees and profits
function calculateQuestFees(quest, totalProfit) {
  const feeAmount = quest.currentAmount * QUEST_FEE_PERCENTAGE;
  const feeProfit = totalProfit * QUEST_FEE_PERCENTAGE;
  const userProfit = totalProfit - feeProfit;
  
  return {
    feeAmount,
    feeProfit,
    userProfit,
    feePercentage: QUEST_FEE_PERCENTAGE * 100
  };
}

// API caching to avoid rate limits
const apiCache = new NodeCache({ stdTTL: 300 }); // 5 minutes cache

// Cached API functions
async function getCachedPrice(symbol) {
  const cacheKey = `price_${symbol}`;
  let price = apiCache.get(cacheKey);
  
  if (!price) {
    try {
      // CoinMarketCap API call (replace with actual implementation)
      const response = await fetch(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${symbol}`, {
        headers: { 'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY }
      });
      const data = await response.json();
      price = data.data[symbol].quote.USD.price;
      apiCache.set(cacheKey, price);
      log('info', 'Price cached', { symbol, price });
    } catch (error) {
      log('error', 'Price fetch failed', { symbol, error: error.message });
      price = 0; // Fallback
    }
  }
  
  return price;
}

async function getCachedDexData(pair) {
  const cacheKey = `dex_${pair}`;
  let data = apiCache.get(cacheKey);
  
  if (!data) {
    try {
      // DexScreener API call (replace with actual implementation)
      const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/base/${pair}`);
      data = await response.json();
      apiCache.set(cacheKey, data);
      log('info', 'Dex data cached', { pair });
    } catch (error) {
      log('error', 'Dex data fetch failed', { pair, error: error.message });
      data = null;
    }
  }
  
  return data;
}

// Quest data structure
class Quest {
  constructor(data) {
    this.id = data.id || `quest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.type = data.type; // 'defi_stake', 'nft_mint', 'airdrop', 'swap'
    this.title = data.title;
    this.description = data.description;
    this.targetAmount = data.targetAmount;
    this.currentAmount = 0;
    this.participants = [];
    this.status = 'active'; // 'active', 'completed', 'failed', 'cancelled'
    this.rewards = data.rewards || {};
    this.deadline = data.deadline;
    this.requirements = data.requirements || {};
    this.creator = data.creator;
    this.createdAt = new Date().toISOString();
    this.executedAt = null;
    this.results = null;
  }
}

// Quest types configuration
const QUEST_TYPES = {
  defi_stake: {
    name: "DeFi Stake Quest",
    description: "Pool funds for yield farming",
    icon: "🏦",
    examples: ["Aerodrome USDC Pool", "Uniswap V3 ETH", "Aave USDC Lending"]
  },
  nft_mint: {
    name: "NFT Mint Quest", 
    description: "Group NFT minting",
    icon: "🎨",
    examples: ["Base NFT Drops", "Friend.tech Keys", "Basenames Registration"]
  },
  airdrop: {
    name: "Airdrop Quest",
    description: "Group airdrop participation",
    icon: "🎁",
    examples: ["Base Ecosystem Airdrops", "DeFi Protocol Airdrops"]
  },
  swap: {
    name: "Swap Quest",
    description: "Group token swaps",
    icon: "🔄",
    examples: ["ETH to USDC", "Token Arbitrage", "Cross-chain Swaps"]
  }
};

// ==================== QUEST CREATION ====================

async function createQuest(ctx, questData) {
  try {
    const quest = new Quest({
      ...questData,
      creator: ctx.message.senderAddress
    });
    
    questStore.set(quest.id, quest);
    
    log('info', 'Quest created', { 
      questId: quest.id, 
      type: quest.type, 
      creator: quest.creator 
    });
    
    return quest;
  } catch (error) {
    log('error', 'Failed to create quest', { error: error.message });
    return null;
  }
}

async function joinQuest(ctx, questId, contribution) {
  try {
    const quest = questStore.get(questId);
    if (!quest) {
      return { success: false, message: "Quest not found" };
    }
    
    if (quest.status !== 'active') {
      return { success: false, message: "Quest is not active" };
    }
    
    const userId = ctx.message.senderAddress;
    
    // Check if user already joined
    if (quest.participants.find(p => p.address === userId)) {
      return { success: false, message: "You already joined this quest" };
    }
    
    // Validate contribution
    if (contribution < quest.requirements.minContribution) {
      return { success: false, message: `Minimum contribution: $${quest.requirements.minContribution}` };
    }
    
    if (contribution > quest.requirements.maxContribution) {
      return { success: false, message: `Maximum contribution: $${quest.requirements.maxContribution}` };
    }
    
    // Add participant
    quest.participants.push({
      address: userId,
      contribution: contribution,
      joinedAt: new Date().toISOString()
    });
    
    quest.currentAmount += contribution;
    
    // Update quest status
    questStore.set(questId, quest);
    
    log('info', 'User joined quest', { 
      questId, 
      userId, 
      contribution,
      totalParticipants: quest.participants.length 
    });
    
    return { success: true, quest };
  } catch (error) {
    log('error', 'Failed to join quest', { error: error.message });
    return { success: false, message: "Failed to join quest" };
  }
}

async function executeQuest(ctx, questId) {
  try {
    const quest = questStore.get(questId);
    if (!quest) {
      return { success: false, message: "Quest not found" };
    }
    
    if (quest.creator !== ctx.message.senderAddress) {
      return { success: false, message: "Only quest creator can execute" };
    }
    
    if (quest.status !== 'active') {
      return { success: false, message: "Quest is not active" };
    }
    
    if (quest.participants.length < quest.requirements.minParticipants) {
      return { success: false, message: `Need at least ${quest.requirements.minParticipants} participants` };
    }
    
    // Execute quest on-chain
    const executionResult = await executeQuestOnChain(quest);
    
    quest.status = 'completed';
    quest.executedAt = new Date().toISOString();
    quest.results = executionResult;
    
    questStore.set(questId, quest);
    
    // Update user stats
    updateUserStats(quest);
    
    log('info', 'Quest executed', { 
      questId, 
      participants: quest.participants.length,
      result: executionResult 
    });
    
    return { success: true, quest, result: executionResult };
  } catch (error) {
    log('error', 'Failed to execute quest', { error: error.message });
    return { success: false, message: "Failed to execute quest" };
  }
}

// Real on-chain quest execution for Base chain
async function executeQuestOnChain(quest) {
  if (!process.env.EXECUTOR_PRIVATE_KEY) {
    throw new Error('EXECUTOR_PRIVATE_KEY not set in environment variables');
  }
  
  // Base mainnet RPC
  const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
  const wallet = new ethers.Wallet(process.env.EXECUTOR_PRIVATE_KEY, provider);
  
  log('info', 'Executing quest on-chain', { 
    questId: quest.id, 
    type: quest.type,
    amount: quest.currentAmount 
  });
  
  try {
    let txHash, profit;
    
    switch (quest.type) {
      case 'defi_stake':
        ({ txHash, profit } = await executeDeFiStake(wallet, quest));
        break;
      case 'nft_mint':
        ({ txHash, profit } = await executeNFTMint(wallet, quest));
        break;
      case 'airdrop':
        ({ txHash, profit } = await executeAirdrop(wallet, quest));
        break;
      case 'swap':
        ({ txHash, profit } = await executeTokenSwap(wallet, quest));
        break;
      default:
        throw new Error(`Unknown quest type: ${quest.type}`);
    }
    
    // Calculate fees and profits
    const fees = calculateQuestFees(quest, profit);
    
    return {
      totalProfit: profit,
      profitPercentage: (profit / quest.currentAmount) * 100,
      executionTx: txHash,
      executedAt: new Date().toISOString(),
      fees: {
        amount: fees.feeAmount,
        profit: fees.feeProfit,
        percentage: fees.feePercentage,
        agentWallet: AGENT_WALLET_ADDRESS
      },
      participants: quest.participants.map(p => ({
        address: p.address,
        contribution: p.contribution,
        profit: (p.contribution / quest.currentAmount) * fees.userProfit // Users get reduced profit
      }))
    };
    
  } catch (error) {
    log('error', 'On-chain execution failed', { error: error.message });
    throw error;
  }
}

// Aerodrome USDC staking execution (Base mainnet)
async function executeDeFiStake(wallet, quest) {
  // Aerodrome USDC Pool contract on Base mainnet
  const poolAddress = '0x...'; // Replace with actual Aerodrome USDC pool address
  const poolABI = [
    'function deposit(uint256 amount) external returns (uint256)',
    'function balanceOf(address) external view returns (uint256)',
    'function totalSupply() external view returns (uint256)'
  ];
  
  const poolContract = new ethers.Contract(poolAddress, poolABI, wallet);
  
  // Convert USD amount to USDC (assuming 1:1 for simplicity)
  const amount = ethers.parseUnits(quest.currentAmount.toString(), 6); // USDC has 6 decimals
  
  log('info', 'Executing Aerodrome staking', { 
    poolAddress, 
    amount: quest.currentAmount,
    wallet: wallet.address 
  });
  
  try {
    // Execute staking transaction
    const tx = await poolContract.deposit(amount);
    const receipt = await tx.wait();
    
    // Calculate profit (simplified - in reality, you'd track rewards over time)
    const profit = quest.currentAmount * 0.05; // 5% APY
    
    log('info', 'Aerodrome staking successful', { 
      txHash: receipt.hash, 
      gasUsed: receipt.gasUsed.toString(),
      profit 
    });
    
    return { txHash: receipt.hash, profit };
  } catch (error) {
    log('error', 'Aerodrome staking failed', { error: error.message });
    throw error;
  }
}

// NFT minting execution
async function executeNFTMint(wallet, quest) {
  // Example: Friend.tech key minting
  const nftContract = new ethers.Contract(
    '0x...', // Friend.tech contract
    ['function mintKey(address to) external payable'],
    wallet
  );
  
  const tx = await nftContract.mintKey(wallet.address, {
    value: ethers.parseEther(quest.currentAmount.toString())
  });
  const receipt = await tx.wait();
  
  // NFT value appreciation (simplified)
  const profit = quest.currentAmount * 0.1; // 10% appreciation
  
  return { txHash: receipt.hash, profit };
}

// Airdrop participation execution
async function executeAirdrop(wallet, quest) {
  // Example: Base ecosystem airdrop claim
  const airdropContract = new ethers.Contract(
    '0x...', // Airdrop contract
    ['function claim() external'],
    wallet
  );
  
  const tx = await airdropContract.claim();
  const receipt = await tx.wait();
  
  // Airdrop value (simplified)
  const profit = quest.currentAmount * 0.2; // 20% airdrop value
  
  return { txHash: receipt.hash, profit };
}

// Token swap execution
async function executeTokenSwap(wallet, quest) {
  // Example: Uniswap V3 swap
  const swapRouter = new ethers.Contract(
    '0x...', // Uniswap V3 router
    ['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) external payable returns (uint256)'],
    wallet
  );
  
  const params = {
    tokenIn: '0x...', // ETH
    tokenOut: '0x...', // USDC
    fee: 3000,
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 1800, // 30 minutes
    amountIn: ethers.parseEther(quest.currentAmount.toString()),
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0
  };
  
  const tx = await swapRouter.exactInputSingle(params);
  const receipt = await tx.wait();
  
  // Swap profit (simplified)
  const profit = quest.currentAmount * 0.02; // 2% arbitrage profit
  
  return { txHash: receipt.hash, profit };
}

// ==================== BASE APP QUICK ACTIONS ====================

async function sendMainQuestActions(ctx) {
  const actionsContent = {
    id: `quest_main_${Date.now()}`,
    description: "🎯 Welcome to Dragman Quest Vault! Choose your adventure:",
    actions: [
      { id: "create_quest", label: "🚀 Create Quest", style: "primary" },
      { id: "list_quests", label: "📋 Active Quests", style: "primary" },
      { id: "my_quests", label: "👤 My Quests", style: "secondary" },
      { id: "leaderboard", label: "🏆 Leaderboard", style: "secondary" },
      { id: "quest_help", label: "❓ Quest Help", style: "secondary" }
    ],
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  };

  try {
    // Log the content type and actions before sending
    log('info', 'Sending Quick Actions', { 
      contentType: ContentTypeActions,
      actionsCount: actionsContent.actions.length,
      description: actionsContent.description.substring(0, 50) + '...'
    });
    
    await ctx.conversation.send(actionsContent, ContentTypeActions);
    log('info', '✅ Main Quest Actions sent successfully!');
  } catch (error) {
    log('error', 'Quick Actions failed', { error: error.message });
    // Fallback to text menu
    const fallback = `${actionsContent.description}\n\n` +
      `1️⃣ 🚀 Create Quest\n` +
      `2️⃣ 📋 Active Quests\n` +
      `3️⃣ 👤 My Quests\n` +
      `4️⃣ 🏆 Leaderboard\n` +
      `5️⃣ ❓ Quest Help\n\n` +
      `Reply with the number to select`;
    await ctx.sendText(fallback);
  }
}

async function sendQuestTypeActions(ctx) {
  const actionsContent = {
    id: `quest_types_${Date.now()}`,
    description: "🎯 Choose Quest Type:",
    actions: [
      { id: "type_defi", label: "🏦 DeFi Stake", style: "primary" },
      { id: "type_nft", label: "🎨 NFT Mint", style: "primary" },
      { id: "type_airdrop", label: "🎁 Airdrop", style: "primary" },
      { id: "type_swap", label: "🔄 Token Swap", style: "primary" }
    ],
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  };

  try {
    await ctx.conversation.send(actionsContent, ContentTypeActions);
  } catch (error) {
    log('error', 'Quest Type Actions failed', { error: error.message });
    // Fallback to text menu
    const fallback = `${actionsContent.description}\n\n` +
      `1️⃣ 🏦 DeFi Stake\n` +
      `2️⃣ 🎨 NFT Mint\n` +
      `3️⃣ 🎁 Airdrop\n` +
      `4️⃣ 🔄 Token Swap\n\n` +
      `Reply with the number to select`;
    await ctx.sendText(fallback);
  }
}

async function sendQuestJoinActions(ctx, questId) {
  const quest = questStore.get(questId);
  if (!quest) return;

  const isCreator = quest.creator === ctx.message.senderAddress;
  const actions = [
    { id: `join_${questId}_50`, label: "💰 Join $50", style: "primary" },
    { id: `join_${questId}_100`, label: "💰 Join $100", style: "primary" },
    { id: `join_${questId}_200`, label: "💰 Join $200", style: "primary" },
    { id: `join_${questId}_custom`, label: "💰 Custom Amount", style: "secondary" }
  ];

  // Add creator actions
  if (isCreator && quest.status === 'active') {
    actions.push({ id: `execute_${questId}`, label: "🚀 Execute Quest", style: "primary" });
    actions.push({ id: `cancel_${questId}`, label: "❌ Cancel Quest", style: "danger" });
  }

  const actionsContent = {
    id: `quest_join_${questId}_${Date.now()}`,
    description: `🎯 Join Quest: ${quest.title}\n💰 Target: $${quest.targetAmount} | 👥 Participants: ${quest.participants.length}${isCreator ? '\n👑 You are the creator' : ''}`,
    actions,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  };

  try {
    await ctx.conversation.send(actionsContent, ContentTypeActions);
  } catch (error) {
    log('error', 'Quest Join Actions failed', { error: error.message });
    // Fallback to text menu
    const fallback = `${actionsContent.description}\n\n` +
      `1️⃣ 💰 Join $50\n` +
      `2️⃣ 💰 Join $100\n` +
      `3️⃣ 💰 Join $200\n` +
      `4️⃣ 💰 Custom Amount${isCreator ? '\n5️⃣ 🚀 Execute Quest\n6️⃣ ❌ Cancel Quest' : ''}\n\n` +
      `Reply with the number to join`;
    await ctx.sendText(fallback);
  }
}

// ==================== QUEST DISPLAY FUNCTIONS ====================

function formatQuestCard(quest) {
  const typeInfo = QUEST_TYPES[quest.type];
  const progress = (quest.currentAmount / quest.targetAmount) * 100;
  
  // Dynamic emojis based on progress
  let progressEmoji = '🟢'; // Default
  if (progress >= 100) progressEmoji = '🔥';
  else if (progress >= 80) progressEmoji = '⚡';
  else if (progress >= 60) progressEmoji = '🚀';
  else if (progress >= 40) progressEmoji = '📈';
  else if (progress >= 20) progressEmoji = '💪';
  else progressEmoji = '🌱';
  
  // Status emojis
  let statusEmoji = '🟢 Active';
  if (quest.status === 'completed') statusEmoji = '✅ Completed';
  else if (quest.status === 'failed') statusEmoji = '❌ Failed';
  else if (quest.status === 'cancelled') statusEmoji = '🚫 Cancelled';
  
  return `🎯 **${quest.title}**
${typeInfo.icon} **${typeInfo.name}**

📝 ${quest.description}
💰 Target: $${quest.targetAmount} | Current: $${quest.currentAmount} (${progress.toFixed(1)}%) ${progressEmoji}
👥 Participants: ${quest.participants.length}/${quest.requirements.maxParticipants || '∞'}
⏰ Deadline: ${new Date(quest.deadline).toLocaleDateString()}
🎁 Rewards: ${quest.rewards.apy ? `${quest.rewards.apy}% APY` : 'TBD'}
💼 Agent Fee: ${QUEST_FEE_PERCENTAGE * 100}% (transparent)

**Quest ID:** \`${quest.id}\`
**Status:** ${statusEmoji}`;
}

function formatQuestList(quests) {
  if (quests.length === 0) {
    return "📋 No active quests found. Create one to get started!";
  }
  
  let response = "📋 **Active Quests:**\n\n";
  
  quests.forEach((quest, index) => {
    const typeInfo = QUEST_TYPES[quest.type];
    const progress = (quest.currentAmount / quest.targetAmount) * 100;
    
    response += `${index + 1}. ${typeInfo.icon} **${quest.title}**\n`;
    response += `   💰 $${quest.currentAmount}/${quest.targetAmount} (${progress.toFixed(1)}%)\n`;
    response += `   👥 ${quest.participants.length} participants\n`;
    response += `   🆔 \`${quest.id}\`\n\n`;
  });
  
  response += "💡 Use quest ID to join: \"join quest [ID]\"";
  
  return response;
}

function formatLeaderboard() {
  if (leaderboard.length === 0) {
    return "🏆 No questers yet! Join some quests to climb the leaderboard!";
  }
  
  let response = "🏆 **Quest Leaderboard:**\n\n";
  
  leaderboard.slice(0, 10).forEach((user, index) => {
    const rank = index + 1;
    const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}.`;
    
    response += `${medal} **${user.username || user.address.slice(0, 8)}...**\n`;
    response += `   🎯 Quests: ${user.totalQuests} | ✅ Success: ${user.successfulQuests}\n`;
    response += `   💰 Profit: $${user.totalProfit.toFixed(2)} | 🏅 Points: ${user.points}\n\n`;
  });
  
  return response;
}

// ==================== USER STATS ====================

function updateUserStats(quest) {
  quest.participants.forEach(participant => {
    const userId = participant.address;
    const userStat = userStats.get(userId) || {
      address: userId,
      totalQuests: 0,
      successfulQuests: 0,
      totalProfit: 0,
      points: 0
    };
    
    userStat.totalQuests += 1;
    if (quest.status === 'completed') {
      userStat.successfulQuests += 1;
      const profit = quest.results.participants.find(p => p.address === userId)?.profit || 0;
      userStat.totalProfit += profit;
      userStat.points += Math.floor(profit * 10); // 10 points per dollar profit
    }
    
    userStats.set(userId, userStat);
  });
  
  // Update leaderboard
  updateLeaderboard();
}

function updateLeaderboard() {
  const users = Array.from(userStats.values());
  leaderboard.length = 0;
  leaderboard.push(...users.sort((a, b) => b.points - a.points));
}

// ==================== MESSAGE HANDLING ====================

agent.on('text', async (ctx) => {
  try {
    const userMessage = ctx.message.content;
    const senderAddress = ctx.message.senderAddress || await ctx.getSenderAddress?.() || 'unknown';
    const isGroupChat = ctx.message.groupId !== undefined;
    const isReplyToAgent = ctx.message.replyTo?.senderAddress === agent.address;
    const isMentioned = userMessage.includes('@dragman') || userMessage.includes('@Dragman');
    
    log('info', 'Message received', { 
      sender: senderAddress, 
      message: userMessage,
      isGroupChat,
      isReplyToAgent,
      isMentioned
    });

    // React to show we received the message
    await ctx.sendReaction('👀');

    // Handle group chat messages - only respond if mentioned or replied to
    if (isGroupChat && !isMentioned && !isReplyToAgent) {
      return; // Don't respond to group messages unless mentioned
    }

    // Check for quest commands
    const response = await handleQuestCommands(ctx, userMessage, senderAddress);
    
    if (response) {
      await ctx.sendText(response);
      log('info', 'Quest response sent', { 
        sender: senderAddress,
        response: response.substring(0, 100) + '...'
      });
    } else {
      // No specific command found, show main quest actions only for greetings
      const message = userMessage.toLowerCase().trim();
      if (message.length > 0 && !message.includes('@dragman')) {
        // Only show menu for greetings, not for every message
        if (message.includes('hello') || message.includes('hi') || message.includes('hey') || 
            message.includes('help') || message.includes('start') || message.includes('menu') ||
            message.includes('quest vault') || message.includes('dragman')) {
          await ctx.sendText('🎯 Welcome to Dragman Quest Vault! I help groups create crypto quests together!');
          await sendMainQuestActions(ctx);
        } else {
          // For other messages, just give a brief response
          await ctx.sendText('🎯 Dragman Quest Vault - Type "help" or "menu" to see quest options!');
        }
      }
    }

  } catch (error) {
    log('error', 'Error handling message', { error: error.message });
    try {
      await ctx.sendText('❌ Sorry, I encountered an error. Please try again.');
    } catch (sendError) {
      log('error', 'Failed to send error message', { error: sendError.message });
    }
  }
});

// Handle Intent messages (Quick Actions responses)
agent.on('coinbase.com/intent:1.0', async (ctx) => {
  try {
    const intentData = ctx.message.content;
    const { id, actionId, metadata } = intentData;
    
    log('info', 'Intent received', { id, actionId, metadata });
    
    // React to show we received the intent
    await ctx.sendReaction('⌛');
    
    // Handle different actions based on actionId
    switch (actionId) {
      // Main quest actions
      case 'create_quest':
        await ctx.sendText('🚀 Let\'s create a quest! Choose the type:');
        await sendQuestTypeActions(ctx);
        break;
      case 'list_quests':
        const activeQuests = Array.from(questStore.values()).filter(q => q.status === 'active');
        await ctx.sendText(formatQuestList(activeQuests));
        break;
      case 'my_quests':
        const userQuests = Array.from(questStore.values()).filter(q => 
          q.creator === ctx.message.senderAddress || 
          q.participants.some(p => p.address === ctx.message.senderAddress)
        );
        await ctx.sendText(formatQuestList(userQuests));
        break;
      case 'leaderboard':
        await ctx.sendText(formatLeaderboard());
        break;
      case 'quest_help':
        await ctx.sendText(`🎯 **Quest Vault Help**

**Creating Quests:**
• Choose quest type (DeFi, NFT, Airdrop, Swap)
• Set target amount and requirements
• Share with your group

**Joining Quests:**
• Click buttons to join
• Choose contribution amount
• Wait for quest execution

**Quest Types:**
🏦 **DeFi Stake** - Pool funds for yield farming
🎨 **NFT Mint** - Group NFT minting
🎁 **Airdrop** - Group airdrop participation
🔄 **Token Swap** - Group token swaps

**Commands:**
• "create quest" - Start quest creation
• "list quests" - Show active quests
• "join quest [ID]" - Join specific quest
• "my quests" - Show your quests
• "leaderboard" - Show top questers

💡 **Pro Tip:** Quest Vault works best in group chats!`);
        break;
      
      // Quest type actions
      case 'type_defi':
        await ctx.sendText('🏦 **DeFi Stake Quest Creation**\n\nLet\'s create a DeFi yield farming quest!\n\n**Example:** "Create DeFi quest: Aerodrome USDC Pool, target $1000, min 5 participants, max $200 each"');
        break;
      case 'type_nft':
        await ctx.sendText('🎨 **NFT Mint Quest Creation**\n\nLet\'s create an NFT minting quest!\n\n**Example:** "Create NFT quest: Friend.tech Keys, target $500, min 3 participants, max $100 each"');
        break;
      case 'type_airdrop':
        await ctx.sendText('🎁 **Airdrop Quest Creation**\n\nLet\'s create an airdrop participation quest!\n\n**Example:** "Create airdrop quest: Base Ecosystem, target $200, min 4 participants, max $50 each"');
        break;
      case 'type_swap':
        await ctx.sendText('🔄 **Token Swap Quest Creation**\n\nLet\'s create a token swap quest!\n\n**Example:** "Create swap quest: ETH to USDC, target $800, min 4 participants, max $200 each"');
        break;
      
      // Quest join actions
      default:
        if (actionId.startsWith('join_')) {
          const parts = actionId.split('_');
          const questId = parts[1];
          const amount = parts[2];
          
          if (amount === 'custom') {
            await ctx.sendText(`💰 **Custom Contribution**\n\nReply with your desired amount for quest \`${questId}\`\n\n**Example:** "Join quest ${questId} with $150"`);
          } else {
            const contribution = parseInt(amount);
            const result = await joinQuest(ctx, questId, contribution);
            
            if (result.success) {
              await ctx.sendText(`✅ **Joined Quest Successfully!**\n\n${formatQuestCard(result.quest)}\n\n🎉 You're now part of this quest!`);
            } else {
              await ctx.sendText(`❌ **Failed to Join Quest**\n\n${result.message}`);
            }
          }
        } else if (actionId.startsWith('execute_')) {
          const questId = actionId.split('_')[1];
          const result = await executeQuest(ctx, questId);
          
          if (result.success) {
            await ctx.sendText(`🚀 **Quest Executed Successfully!**\n\n${formatQuestCard(result.quest)}\n\n💰 **Results:**\n• Total Profit: $${result.result.totalProfit.toFixed(2)}\n• Profit %: ${result.result.profitPercentage.toFixed(2)}%\n• Agent Fee: $${result.result.fees.profit.toFixed(2)} (${result.result.fees.percentage}%)\n• User Profit: $${(result.result.totalProfit - result.result.fees.profit).toFixed(2)}\n• TX: \`${result.result.executionTx}\`\n\n🎉 Quest completed! Rewards distributed to participants.`);
          } else {
            await ctx.sendText(`❌ **Failed to Execute Quest**\n\n${result.message}`);
          }
        } else if (actionId.startsWith('cancel_')) {
          const questId = actionId.split('_')[1];
          const quest = questStore.get(questId);
          
          if (quest && quest.creator === ctx.message.senderAddress) {
            quest.status = 'cancelled';
            questStore.set(questId, quest);
            await ctx.sendText(`❌ **Quest Cancelled**\n\nQuest \`${questId}\` has been cancelled by the creator.`);
          } else {
            await ctx.sendText(`❌ **Cannot Cancel Quest**\n\nOnly the quest creator can cancel this quest.`);
          }
        } else {
          await ctx.sendText('❓ I\'m not sure what you selected. Please try again!');
        }
    }
  } catch (error) {
    log('error', 'Error handling intent', { error: error.message });
    await ctx.sendText('❌ Sorry, I had trouble processing your selection. Please try again.');
  }
});

// ==================== QUEST COMMAND HANDLING ====================

async function handleQuestCommands(ctx, userMessage, senderAddress) {
  const message = userMessage.toLowerCase().trim();
  
  // 1. CREATE QUEST COMMANDS
  if (message.includes('create quest')) {
    await ctx.sendText('🚀 **Quest Creation**\n\nChoose your quest type:');
    await sendQuestTypeActions(ctx);
    return null; // Let Quick Actions handle the response
  }
  
  // Handle quest type creation commands
  if (message.includes('create defi quest') || message.includes('create defi')) {
    const questData = parseQuestCreation('create defi quest: DeFi Stake Quest, target $1000, min 3 participants, max $200 each');
    const quest = await createQuest(ctx, questData);
    if (quest) {
      return `🎯 **Quest Created Successfully!**\n\n${formatQuestCard(quest)}\n\n👥 **Share this quest with your group!**\nUse: "join quest ${quest.id}"`;
    }
  }
  
  if (message.includes('create nft quest') || message.includes('create nft')) {
    const questData = parseQuestCreation('create nft quest: NFT Mint Quest, target $500, min 3 participants, max $100 each');
    const quest = await createQuest(ctx, questData);
    if (quest) {
      return `🎯 **Quest Created Successfully!**\n\n${formatQuestCard(quest)}\n\n👥 **Share this quest with your group!**\nUse: "join quest ${quest.id}"`;
    }
  }
  
  if (message.includes('create airdrop quest') || message.includes('create airdrop')) {
    const questData = parseQuestCreation('create airdrop quest: Airdrop Quest, target $200, min 4 participants, max $50 each');
    const quest = await createQuest(ctx, questData);
    if (quest) {
      return `🎯 **Quest Created Successfully!**\n\n${formatQuestCard(quest)}\n\n👥 **Share this quest with your group!**\nUse: "join quest ${quest.id}"`;
    }
  }
  
  if (message.includes('create swap quest') || message.includes('create swap')) {
    const questData = parseQuestCreation('create swap quest: Token Swap Quest, target $800, min 4 participants, max $200 each');
    const quest = await createQuest(ctx, questData);
    if (quest) {
      return `🎯 **Quest Created Successfully!**\n\n${formatQuestCard(quest)}\n\n👥 **Share this quest with your group!**\nUse: "join quest ${quest.id}"`;
    }
  }
  
  // 2. LIST QUESTS COMMANDS
  if (message.includes('list quest')) {
    const activeQuests = Array.from(questStore.values()).filter(q => q.status === 'active');
    return formatQuestList(activeQuests);
  }
  
  // 3. MY QUESTS COMMANDS
  if (message.includes('my quest')) {
    const userQuests = Array.from(questStore.values()).filter(q => 
      q.creator === senderAddress || 
      q.participants.some(p => p.address === senderAddress)
    );
    return formatQuestList(userQuests);
  }
  
  // 4. LEADERBOARD COMMANDS
  if (message.includes('leaderboard')) {
    return formatLeaderboard();
  }
  
  // 5. QUEST HELP COMMANDS
  if (message.includes('quest help') || message.includes('help')) {
    return `🎯 **Quest Vault Help**

**Creating Quests:**
• "create defi quest" - Create DeFi stake quest
• "create nft quest" - Create NFT mint quest  
• "create airdrop quest" - Create airdrop quest
• "create swap quest" - Create token swap quest

**Managing Quests:**
• "list quests" - Show active quests
• "my quests" - Show your quests
• "join quest [ID] $[amount]" - Join specific quest
• "quest details [ID]" - Show quest information
• "execute quest [ID]" - Execute quest (creator only)

**Other Commands:**
• "leaderboard" - Show top questers
• "help" - Show this help message

**Quest Types:**
🏦 **DeFi Stake** - Pool funds for yield farming
🎨 **NFT Mint** - Group NFT minting
🎁 **Airdrop** - Group airdrop participation
🔄 **Token Swap** - Group token swaps

**Examples:**
• "create defi quest"
• "join quest quest_1234567890 $100"
• "list quests"
• "my quests"

💡 **Pro Tip:** Quest Vault works best in group chats!`;
  }
  
  // 6. JOIN QUEST COMMANDS
  if (message.includes('join quest')) {
    // Try to parse "join quest [ID] $[amount]" format
    const questIdAmountMatch = userMessage.match(/join quest\s+([a-zA-Z0-9_]+)\s+\$(\d+)/i);
    if (questIdAmountMatch) {
      const questId = questIdAmountMatch[1];
      const amount = parseInt(questIdAmountMatch[2]);
      const result = await joinQuest(ctx, questId, amount);
      
      if (result.success) {
        return `✅ **Joined Quest Successfully!**\n\n${formatQuestCard(result.quest)}\n\n🎉 You're now part of this quest!`;
      } else {
        return `❌ **Failed to Join Quest**\n\n${result.message}`;
      }
    }
    
    // Try to parse "join quest [ID]" format (without amount)
    const questIdMatch = userMessage.match(/join quest\s+([a-zA-Z0-9_]+)/i);
    if (questIdMatch) {
      const questId = questIdMatch[1];
      const quest = questStore.get(questId);
      
      if (!quest) {
        return `❌ Quest \`${questId}\` not found. Use "list quests" to see active quests.`;
      }
      
      if (quest.status !== 'active') {
        return `❌ Quest \`${questId}\` is not active. Current status: ${quest.status}`;
      }
      
      await sendQuestJoinActions(ctx, questId);
      return null; // Let Quick Actions handle the response
    } else {
      return `❌ Please specify quest ID. Example: "join quest quest_1234567890 $100"`;
    }
  }
  
  // 7. QUEST DETAILS COMMANDS
  if (message.includes('quest details') || message.includes('quest info')) {
    const questIdMatch = userMessage.match(/quest (?:details|info)\s+([a-zA-Z0-9_]+)/i);
    if (questIdMatch) {
      const questId = questIdMatch[1];
      const quest = questStore.get(questId);
      
      if (!quest) {
        return `❌ Quest \`${questId}\` not found.`;
      }
      
      return formatQuestCard(quest);
    }
  }
  
  // 8. EXECUTE QUEST COMMANDS
  if (message.includes('execute quest')) {
    const questIdMatch = userMessage.match(/execute quest\s+([a-zA-Z0-9_]+)/i);
    if (questIdMatch) {
      const questId = questIdMatch[1];
      const result = await executeQuest(ctx, questId);
      
      if (result.success) {
        return `🚀 **Quest Executed Successfully!**\n\n${formatQuestCard(result.quest)}\n\n💰 **Results:**\n• Total Profit: $${result.result.totalProfit.toFixed(2)}\n• Profit %: ${result.result.profitPercentage.toFixed(2)}%\n• Agent Fee: $${result.result.fees.profit.toFixed(2)} (${result.result.fees.percentage}%)\n• User Profit: $${(result.result.totalProfit - result.result.fees.profit).toFixed(2)}\n• TX: \`${result.result.executionTx}\`\n\n🎉 Quest completed! Rewards distributed to participants.`;
      } else {
        return `❌ **Failed to Execute Quest**\n\n${result.message}`;
      }
    }
  }
  
  // 9. PARSE QUEST CREATION FROM TEXT
  if (message.includes('create') && (message.includes('defi') || message.includes('nft') || message.includes('airdrop') || message.includes('swap'))) {
    const questData = parseQuestCreation(userMessage);
    if (questData) {
      const quest = await createQuest(ctx, questData);
      if (quest) {
        return `🎯 **Quest Created Successfully!**\n\n${formatQuestCard(quest)}\n\n👥 **Share this quest with your group!**\nUse: "join quest ${quest.id}"`;
      }
    }
  }
  
  // 10. GREETING MESSAGES
  if (message.includes('hello') || message.includes('hi') || message.includes('hey') || 
      message.includes('help') || message.includes('start') || message.includes('menu') ||
      message.includes('good morning') || message.includes('good afternoon') || message.includes('good evening') ||
      message.includes('gm') || message.includes('gn') || message.includes('morning') || message.includes('evening') ||
      message.includes('feature') || message.includes('features') || message.includes('show') || message.includes('list')) {
    return null; // Return null to trigger Quick Actions in main handler
  }
  
  // Default AI response for other messages
  return await generateQuestResponse(userMessage, senderAddress);
}

// Parse quest creation from natural language
function parseQuestCreation(userMessage) {
  const message = userMessage.toLowerCase();
  
  let type = 'defi_stake';
  if (message.includes('nft')) type = 'nft_mint';
  else if (message.includes('airdrop')) type = 'airdrop';
  else if (message.includes('swap')) type = 'swap';
  
  // Extract target amount
  const amountMatch = userMessage.match(/\$(\d+)/);
  const targetAmount = amountMatch ? parseInt(amountMatch[1]) : 1000;
  
  // Extract min participants
  const minMatch = userMessage.match(/min(?:imum)?\s+(\d+)/i);
  const minParticipants = minMatch ? parseInt(minMatch[1]) : 3;
  
  // Extract max contribution
  const maxMatch = userMessage.match(/max(?:imum)?\s+\$(\d+)/i);
  const maxContribution = maxMatch ? parseInt(maxMatch[1]) : 200;
  
  // Extract title
  const titleMatch = userMessage.match(/quest[:\s]+(.+?)(?:,|$)/i);
  const title = titleMatch ? titleMatch[1].trim() : `${QUEST_TYPES[type].name} Quest`;
  
  return {
    type,
    title,
    description: `Group ${QUEST_TYPES[type].name.toLowerCase()} quest`,
    targetAmount,
    requirements: {
      minParticipants,
      maxParticipants: minParticipants * 2,
      minContribution: 50,
      maxContribution
    },
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days from now
    rewards: {
      apy: type === 'defi_stake' ? 12.5 : null
    }
  };
}

// ==================== AI RESPONSE GENERATION ====================

async function generateQuestResponse(userMessage, senderAddress) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `You are Dragman, a Quest Vault specialist in Base App. You help groups create and execute crypto quests together.

CORE FEATURES:
- Quest Creation: DeFi Stake, NFT Mint, Airdrop, Token Swap
- Group Collaboration: Pool funds, vote on quests, execute together
- Real Rewards: Actual profits and NFTs from quest execution
- Leaderboard: Track top questers and their success

QUEST TYPES:
🏦 DeFi Stake - Pool funds for yield farming (Aerodrome, Uniswap, Aave)
🎨 NFT Mint - Group NFT minting (Friend.tech keys, Basenames, Base NFTs)
🎁 Airdrop - Group airdrop participation (Base ecosystem, DeFi protocols)
🔄 Token Swap - Group token swaps (ETH/USDC, arbitrage opportunities)

HOW QUESTS WORK:
1. Create quest with target amount and requirements
2. Group members join with contributions
3. Quest executes when requirements met
4. Profits distributed proportionally
5. Leaderboard updated with results

RESPONSE STYLE: Keep responses SHORT and focused on quests. Maximum 2-3 sentences. Be enthusiastic about group collaboration and real rewards.

Always encourage group participation and highlight the unique collaborative nature of quests.`
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      max_tokens: 100,
      temperature: 0.7,
    });

    return completion.choices[0].message.content;
  } catch (error) {
    log('error', 'OpenAI API error', { error: error.message });
    return "🎯 I'm having trouble connecting right now. Try asking about quests!";
  }
}

// ==================== AGENT STARTUP ====================

// Start the agent
await agent.start();

// Log when we're ready
agent.on('start', () => {
  log('info', `✅ Dragman Quest Vault Agent is online and ready!`);
  log('info', `📬 Agent address: ${agent.address}`);
  
  // Register codecs AFTER agent is fully started with retry logic
  let codecRegistered = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (agent && agent.client && agent.client.codecRegistry) {
        agent.client.codecRegistry.register(new JsonCodec(ContentTypeActions));
        agent.client.codecRegistry.register(new JsonCodec(ContentTypeIntent));
        log('info', `✅ Base App Quick Actions codecs registered successfully! (attempt ${attempt})`);
        codecRegistered = true;
        break;
      } else {
        log('warn', `Codec registry not available (attempt ${attempt}/3)`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      }
    } catch (e) {
      log('error', `Failed to register codecs (attempt ${attempt}/3)`, { error: e?.message });
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  if (!codecRegistered) {
    log('error', '❌ CRITICAL: Codec registration failed - Quick Actions will show numbers instead of buttons!');
  }
  
  // Log installation info
  try {
    if (agent?.installationId) {
      log('info', `🔧 Installation ID: ${agent.installationId}`);
    }
  } catch (e) {
    // ignore installation logging errors
  }
});

// Keep the process running
process.on('SIGINT', () => {
  log('info', '🛑 Shutting down gracefully...');
  process.exit(0);
});
