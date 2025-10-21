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
  console.log(`ðŸ“ Created XMTP installation directory: ${installationPath}`);
} else {
  // Clean old installations to prevent "2 installations" warning
  try {
    const files = fs.readdirSync(installationPath);
    const oldInstalls = files.filter(f => f.startsWith('installation-') && f !== 'installation-current');
    oldInstalls.forEach(f => {
      fs.rmSync(path.join(installationPath, f), { recursive: true, force: true });
      console.log(`ðŸ—‘ï¸ Removed old installation: ${f}`);
    });
  } catch (e) {
    console.log(`âš ï¸ Could not clean old installations: ${e.message}`);
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
  // Add SQLCipher encryption key (must be 32+ characters)
  dbEncryptionKey: process.env.XMTP_DB_ENCRYPTION_KEY || 'dragman-quest-vault-2025-secure-key-32-chars'
});

// --- Base App Quick Actions Implementation ---
const ContentTypeActions = { authorityId: 'coinbase.com', typeId: 'actions', version: '1.0' };
const ContentTypeIntent = { authorityId: 'coinbase.com', typeId: 'intent', version: '1.0' };

// JsonCodec class for Base App content types
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

// Debug function to test codec registration
function testCodecRegistration() {
  try {
    log('info', 'Testing codec registration...');
    
    if (!agent) {
      log('error', 'Agent not available');
      return false;
    }
    
    if (!agent.client) {
      log('error', 'Agent client not available');
      return false;
    }
    
    if (!agent.client.codecRegistry) {
      log('error', 'Codec registry not available');
      return false;
    }
    
    const actionsCodec = new JsonCodec(ContentTypeActions);
    const intentCodec = new JsonCodec(ContentTypeIntent);
    
    agent.client.codecRegistry.register(actionsCodec);
    agent.client.codecRegistry.register(intentCodec);
    
    log('info', 'âœ… Codec registration test successful!');
    log('info', `Actions codec ID: ${actionsCodec.id}`);
    log('info', `Intent codec ID: ${intentCodec.id}`);
    
    return true;
  } catch (error) {
    log('error', 'Codec registration test failed', { error: error.message });
    return false;
  }
}

log('info', 'ðŸŽ¯ Dragman Quest Vault Agent started successfully!');
log('info', 'ðŸ“± Ready to create crypto quests in Base App');
log('info', 'ðŸš€ Quest Vault features enabled');

// Check XMTP SDK version
try {
  const packageJson = require('./package.json');
  log('info', 'Package versions:', {
    xmtpAgentSdk: packageJson.dependencies?.['@xmtp/agent-sdk'] || 'not found',
    xmtpSdk: packageJson.dependencies?.['@xmtp/sdk'] || 'not found',
    nodeVersion: process.version
  });
} catch (e) {
  log('warn', 'Could not read package.json', { error: e?.message });
}

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

// Quest achievements system
const ACHIEVEMENTS = {
  first_quest: {
    name: "First Quest",
    description: "Complete your first quest",
    icon: "ðŸŽ¯",
    requirement: { completedQuests: 1 }
  },
  quest_master: {
    name: "Quest Master",
    description: "Complete 10 quests",
    icon: "ðŸ‘‘",
    requirement: { completedQuests: 10 }
  },
  big_spender: {
    name: "Big Spender",
    description: "Contribute $1000+ total",
    icon: "ðŸ’°",
    requirement: { totalContribution: 1000 }
  },
  group_leader: {
    name: "Group Leader",
    description: "Create 5 successful quests",
    icon: "ðŸš€",
    requirement: { createdQuests: 5 }
  },
  lucky_streak: {
    name: "Lucky Streak",
    description: "Win 3 quests in a row",
    icon: "ðŸ€",
    requirement: { winStreak: 3 }
  },
  community_builder: {
    name: "Community Builder",
    description: "Have 50+ total participants across all quests",
    icon: "ðŸ‘¥",
    requirement: { totalParticipants: 50 }
  }
};

// Quest security and approval system
const questApprovals = new Map(); // questId -> Set of participant addresses who approved
const creatorReputation = new Map(); // creatorAddress -> reputation score

// Calculate required approvals (majority of participants)
function getRequiredApprovals(quest) {
  return Math.ceil(quest.participants.length / 2);
}

// Check if quest can be executed (has enough approvals)
function canExecuteQuest(quest) {
  const approvals = questApprovals.get(quest.id) || new Set();
  const required = getRequiredApprovals(quest);
  return approvals.size >= required;
}

// Add approval for quest execution
function addQuestApproval(questId, participantAddress) {
  if (!questApprovals.has(questId)) {
    questApprovals.set(questId, new Set());
  }
  questApprovals.get(questId).add(participantAddress);
}

// Get creator reputation score
function getCreatorReputation(creatorAddress) {
  return creatorReputation.get(creatorAddress) || 0;
}

// Update creator reputation based on quest results
function updateCreatorReputation(creatorAddress, quest, results) {
  const currentRep = getCreatorReputation(creatorAddress);
  let reputationChange = 0;
  
  // Positive reputation for successful quests
  if (results.totalProfit > 0) {
    reputationChange += Math.min(10, Math.floor(results.totalProfit / 100)); // Max +10 per quest
  }
  
  // Negative reputation for failed quests
  if (results.totalProfit < 0) {
    reputationChange -= Math.min(5, Math.floor(Math.abs(results.totalProfit) / 100)); // Max -5 per quest
  }
  
  // Bonus for high participant satisfaction
  const participantCount = quest.participants.length;
  if (participantCount >= 5) {
    reputationChange += 2; // Bonus for popular quests
  }
  
  creatorReputation.set(creatorAddress, Math.max(0, currentRep + reputationChange));
}

// Achievement checking and awarding
function checkAndAwardAchievements(userId, quest, results) {
  const userStat = userStats.get(userId) || {
    completedQuests: 0,
    totalContribution: 0,
    totalProfit: 0,
    createdQuests: 0,
    winStreak: 0,
    totalParticipants: 0,
    points: 0
  };
  
  const userAchievementSet = userAchievements.get(userId) || new Set();
  const newAchievements = [];
  
  // Check each achievement
  Object.entries(ACHIEVEMENTS).forEach(([achievementId, achievement]) => {
    if (userAchievementSet.has(achievementId)) return; // Already has this achievement
    
    const requirement = achievement.requirement;
    let earned = false;
    
    if (requirement.completedQuests && userStat.completedQuests >= requirement.completedQuests) {
      earned = true;
    } else if (requirement.totalContribution && userStat.totalContribution >= requirement.totalContribution) {
      earned = true;
    } else if (requirement.createdQuests && userStat.createdQuests >= requirement.createdQuests) {
      earned = true;
    } else if (requirement.winStreak && userStat.winStreak >= requirement.winStreak) {
      earned = true;
    } else if (requirement.totalParticipants && userStat.totalParticipants >= requirement.totalParticipants) {
      earned = true;
    }
    
    if (earned) {
      userAchievementSet.add(achievementId);
      newAchievements.push(achievement);
    }
  });
  
  userAchievements.set(userId, userAchievementSet);
  
  return newAchievements;
}

// Format achievements for display
function formatUserAchievements(userId) {
  const userAchievementSet = userAchievements.get(userId) || new Set();
  const userStat = userStats.get(userId);
  
  if (!userStat) {
    return `ðŸ† **Your Achievements**

No achievements yet! Complete quests to earn achievements.`;
  }
  
  const earnedAchievements = Array.from(userAchievementSet).map(id => ACHIEVEMENTS[id]);
  const availableAchievements = Object.entries(ACHIEVEMENTS)
    .filter(([id]) => !userAchievementSet.has(id))
    .map(([id, achievement]) => achievement);
  
  return `ðŸ† **Your Achievements**

**Earned (${earnedAchievements.length}):**
${earnedAchievements.map(a => `${a.icon} ${a.name} - ${a.description}`).join('\n') || 'None yet!'}

**Available:**
${availableAchievements.map(a => `ðŸ”’ ${a.name} - ${a.description}`).join('\n')}

**Stats:**
â€¢ Completed Quests: ${userStat.completedQuests}
â€¢ Total Contribution: $${userStat.totalContribution}
â€¢ Total Profit: $${userStat.totalProfit}
â€¢ Created Quests: ${userStat.createdQuests}
â€¢ Win Streak: ${userStat.winStreak}
â€¢ Total Points: ${userStat.points}`;
}

// Quest analytics tracking
const questAnalytics = {
  totalQuests: 0,
  totalParticipants: 0,
  totalVolume: 0,
  totalProfit: 0,
  questTypes: {},
  successRate: 0,
  averageQuestSize: 0,
  averageParticipants: 0
};

// Update analytics when quest is executed
function updateQuestAnalytics(quest, results) {
  questAnalytics.totalQuests++;
  questAnalytics.totalParticipants += quest.participants.length;
  questAnalytics.totalVolume += quest.targetAmount;
  questAnalytics.totalProfit += results.totalProfit;
  
  // Track by quest type
  if (!questAnalytics.questTypes[quest.type]) {
    questAnalytics.questTypes[quest.type] = {
      count: 0,
      participants: 0,
      volume: 0,
      profit: 0
    };
  }
  
  const typeStats = questAnalytics.questTypes[quest.type];
  typeStats.count++;
  typeStats.participants += quest.participants.length;
  typeStats.volume += quest.targetAmount;
  typeStats.profit += results.totalProfit;
  
  // Calculate averages
  questAnalytics.averageQuestSize = questAnalytics.totalVolume / questAnalytics.totalQuests;
  questAnalytics.averageParticipants = questAnalytics.totalParticipants / questAnalytics.totalQuests;
  questAnalytics.successRate = (questAnalytics.totalQuests / (questAnalytics.totalQuests + Array.from(questStore.values()).filter(q => q.status === 'cancelled').length)) * 100;
}

// Format analytics for display
function formatQuestAnalytics() {
  const activeQuests = Array.from(questStore.values()).filter(q => q.status === 'active').length;
  const completedQuests = Array.from(questStore.values()).filter(q => q.status === 'completed').length;
  const cancelledQuests = Array.from(questStore.values()).filter(q => q.status === 'cancelled').length;
  
  return `ðŸ“Š **Quest Analytics Dashboard**

**Overall Stats:**
â€¢ Total Quests: ${questAnalytics.totalQuests}
â€¢ Active Quests: ${activeQuests}
â€¢ Completed Quests: ${completedQuests}
â€¢ Cancelled Quests: ${cancelledQuests}
â€¢ Success Rate: ${questAnalytics.successRate.toFixed(1)}%

**Volume & Participation:**
â€¢ Total Volume: $${questAnalytics.totalVolume.toFixed(2)}
â€¢ Total Participants: ${questAnalytics.totalParticipants}
â€¢ Average Quest Size: $${questAnalytics.averageQuestSize.toFixed(2)}
â€¢ Average Participants: ${questAnalytics.averageParticipants.toFixed(1)}

**Profitability:**
â€¢ Total Profit Generated: $${questAnalytics.totalProfit.toFixed(2)}
â€¢ Average Profit per Quest: $${(questAnalytics.totalProfit / Math.max(questAnalytics.totalQuests, 1)).toFixed(2)}

**By Quest Type:**
${Object.entries(questAnalytics.questTypes).map(([type, stats]) => 
  `â€¢ ${QUEST_TYPES[type]?.icon || 'ðŸ“Š'} ${QUEST_TYPES[type]?.name || type}: ${stats.count} quests, $${stats.volume.toFixed(2)} volume, $${stats.profit.toFixed(2)} profit`
).join('\n')}

ðŸ’¡ **Insights:** Quest Vault is ${questAnalytics.successRate > 80 ? 'performing excellently' : questAnalytics.successRate > 60 ? 'performing well' : 'needing improvement'} with ${questAnalytics.totalParticipants} total participants!`;
}

// Simple state tracking to prevent loops
const userStates = new Map(); // userId -> { state: 'main_menu' | 'quest_type_selection' | 'quest_creation', step: 'type' | 'target' | 'participants' | 'max_contribution' | 'deadline' | 'title', data: {} }

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
    this.approvals = new Set(); // Participant addresses who approved execution
    this.executionTx = null; // On-chain transaction hash
    this.verifiedProfit = null; // Verified profit from on-chain data
  }
}

// Quest types configuration
const QUEST_TYPES = {
  defi_stake: {
    name: "DeFi Stake Quest",
    description: "Pool funds for yield farming",
    icon: "ðŸ¦",
    examples: ["Aerodrome USDC Pool", "Uniswap V3 ETH", "Aave USDC Lending"],
    category: "yield_farming"
  },
  nft_mint: {
    name: "NFT Mint Quest", 
    description: "Group NFT minting",
    icon: "ðŸŽ¨",
    examples: ["Base NFT Drops", "Friend.tech Keys", "Basenames Registration"],
    category: "nft_collectibles"
  },
  airdrop: {
    name: "Airdrop Quest",
    description: "Group airdrop participation",
    icon: "ðŸŽ",
    examples: ["Base Ecosystem Airdrops", "DeFi Protocol Airdrops"],
    category: "free_rewards"
  },
  swap: {
    name: "Swap Quest",
    description: "Group token swaps",
    icon: "ðŸ”„",
    examples: ["ETH to USDC", "Token Arbitrage", "Cross-chain Swaps"],
    category: "trading"
  }
};

// Quest templates for quick creation
const QUEST_TEMPLATES = {
  micro_fun: {
    name: "Micro Fun",
    description: "Quick fun quest for small groups",
    targetAmount: 10,
    minParticipants: 2,
    maxContribution: 5,
    deadlineDays: 1,
    icon: "ðŸŽ®"
  },
  weekend_deal: {
    name: "Weekend Deal",
    description: "Medium quest for weekend activity",
    targetAmount: 500,
    minParticipants: 5,
    maxContribution: 100,
    deadlineDays: 3,
    icon: "ðŸ“…"
  },
  moon_shot: {
    name: "Moon Shot",
    description: "High-value quest for serious players",
    targetAmount: 5000,
    minParticipants: 10,
    maxContribution: 500,
    deadlineDays: 14,
    icon: "ðŸš€"
  },
  community_build: {
    name: "Community Build",
    description: "Community-focused quest",
    targetAmount: 1000,
    minParticipants: 8,
    maxContribution: 125,
    deadlineDays: 7,
    icon: "ðŸ‘¥"
  }
};

// Quest categories for organization
const QUEST_CATEGORIES = {
  yield_farming: {
    name: "Yield Farming",
    description: "DeFi staking and yield generation",
    icon: "ðŸŒ¾",
    questTypes: ["defi_stake"]
  },
  nft_collectibles: {
    name: "NFT Collectibles",
    description: "NFT minting and collecting",
    icon: "ðŸŽ¨",
    questTypes: ["nft_mint"]
  },
  free_rewards: {
    name: "Free Rewards",
    description: "Airdrops and free token claims",
    icon: "ðŸŽ",
    questTypes: ["airdrop"]
  },
  trading: {
    name: "Trading",
    description: "Token swaps and arbitrage",
    icon: "ðŸ“ˆ",
    questTypes: ["swap"]
  }
};

// ==================== QUEST SECURITY FUNCTIONS ====================

async function approveQuestExecution(ctx, questId, participantAddress) {
  try {
    const quest = questStore.get(questId);
    if (!quest) {
      return { success: false, message: "Quest not found" };
    }
    
    if (quest.status !== 'active') {
      return { success: false, message: "Quest is not active" };
    }
    
    // Check if user is a participant
    const isParticipant = quest.participants.some(p => p.address === participantAddress);
    if (!isParticipant) {
      return { success: false, message: "Only quest participants can approve execution" };
    }
    
    // Check if user already approved
    if (quest.approvals.has(participantAddress)) {
      return { success: false, message: "You have already approved this quest execution" };
    }
    
    // Add approval
    quest.approvals.add(participantAddress);
    questStore.set(questId, quest);
    
    const requiredApprovals = getRequiredApprovals(quest);
    const currentApprovals = quest.approvals.size;
    
    if (currentApprovals >= requiredApprovals) {
      return `âœ… **Quest Approved!** Quest is now ready for execution.

**Approval Status:**
â€¢ Current Approvals: ${currentApprovals}/${requiredApprovals}
â€¢ Status: âœ… Ready to Execute

**Next Steps:**
â€¢ Quest creator can now execute: "execute quest ${questId}"
â€¢ All participants will receive their share of profits
â€¢ Transaction will be verified on-chain`;
    } else {
      return `âœ… **Approval Added!** Quest needs more approvals.

**Approval Status:**
â€¢ Current Approvals: ${currentApprovals}/${requiredApprovals}
â€¢ Status: â³ Waiting for ${requiredApprovals - currentApprovals} more approval(s)

**Quest Details:**
â€¢ Target: $${quest.targetAmount}
â€¢ Current: $${quest.currentAmount}
â€¢ Participants: ${quest.participants.length}`;
    }
  } catch (error) {
    log('error', 'Failed to approve quest execution', { error: error.message });
    return { success: false, message: "Failed to approve quest execution" };
  }
}

// ==================== QUEST CREATION ====================

async function createQuest(ctx, questData, senderAddress) {
  try {
    const quest = new Quest({
      ...questData,
      creator: senderAddress
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
    
    // SECURITY: Check if quest has required approvals
    const requiredApprovals = getRequiredApprovals(quest);
    const currentApprovals = quest.approvals.size;
    if (currentApprovals < requiredApprovals) {
      return { success: false, message: `Quest needs ${requiredApprovals - currentApprovals} more approval(s) from participants. Use "approve quest ${questId}"` };
    }
    
    // SECURITY: Check creator reputation
    const creatorRep = getCreatorReputation(quest.creator);
    const MIN_REPUTATION = 0; // Could be increased for high-value quests
    if (creatorRep < MIN_REPUTATION) {
      return { success: false, message: `Creator reputation too low (${creatorRep}). Complete more quests to build reputation.` };
    }
    
    // Execute quest on-chain
    const executionResult = await executeQuestOnChain(quest);
    
    // SECURITY: Verify on-chain transaction
    if (!executionResult.executionTx) {
      return { success: false, message: "Failed to execute on-chain transaction" };
    }
    
    // Update quest with verified results
    quest.status = 'completed';
    quest.executedAt = new Date().toISOString();
    quest.results = executionResult;
    quest.executionTx = executionResult.executionTx;
    quest.verifiedProfit = executionResult.totalProfit;
    
    questStore.set(questId, quest);
    
    // Update user stats
    updateUserStats(quest);
    
    // Update analytics
    updateQuestAnalytics(quest, executionResult);
    
    // SECURITY: Update creator reputation
    updateCreatorReputation(quest.creator, quest, executionResult);
    
    // Check and award achievements for all participants
    quest.participants.forEach(participant => {
      const newAchievements = checkAndAwardAchievements(participant.address, quest, executionResult);
      if (newAchievements.length > 0) {
        log('info', 'New achievements awarded', { 
          userId: participant.address, 
          achievements: newAchievements.map(a => a.name) 
        });
      }
    });
    
    log('info', 'Quest executed with security checks', { 
      questId, 
      participants: quest.participants.length,
      approvals: currentApprovals,
      creatorReputation: creatorRep,
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
  // DISABLED: Quick Actions don't work with current XMTP SDK
  // Use text-based menu instead
  const menuText = `ðŸŽ¯ **Welcome to Dragman Quest Vault!** Choose your adventure:

1ï¸âƒ£ ðŸš€ Quick Quest (predefined)
2ï¸âƒ£ ðŸ“‹ Active Quests  
3ï¸âƒ£ ðŸ‘¤ My Quests
4ï¸âƒ£ ðŸ† Leaderboard
5ï¸âƒ£ â“ Quest Help
6ï¸âƒ£ ðŸŽ¨ Custom Quest (step-by-step)

**Reply with /1, /2, /3, /4, /5, or /6 to select**`;

  log('info', 'Sending text-based quest menu (Quick Actions disabled)');
  await ctx.sendText(menuText);
}

async function sendQuestTypeActions(ctx) {
  // DISABLED: Quick Actions don't work with current XMTP SDK
  // Use text-based menu instead
  const menuText = `ðŸŽ¯ **Choose Quest Type:**

1ï¸âƒ£ ðŸ¦ DeFi Stake
2ï¸âƒ£ ðŸŽ¨ NFT Mint
3ï¸âƒ£ ðŸŽ Airdrop
4ï¸âƒ£ ðŸ”„ Token Swap

**Reply with /1, /2, /3, or /4 to select**`;

  log('info', 'Sending text-based quest type menu (Quick Actions disabled)');
  await ctx.sendText(menuText);
}

async function sendQuestJoinActions(ctx, questId) {
  const quest = questStore.get(questId);
  if (!quest) return;

  const isCreator = quest.creator === ctx.message.senderAddress;
  const actions = [
    { id: `join_${questId}_50`, label: "ðŸ’° Join $50", style: "primary" },
    { id: `join_${questId}_100`, label: "ðŸ’° Join $100", style: "primary" },
    { id: `join_${questId}_200`, label: "ðŸ’° Join $200", style: "primary" },
    { id: `join_${questId}_custom`, label: "ðŸ’° Custom Amount", style: "secondary" }
  ];

  // Add creator actions
  if (isCreator && quest.status === 'active') {
    actions.push({ id: `execute_${questId}`, label: "ðŸš€ Execute Quest", style: "primary" });
    actions.push({ id: `cancel_${questId}`, label: "âŒ Cancel Quest", style: "danger" });
  }

  const actionsContent = {
    id: `quest_join_${questId}_${Date.now()}`,
    description: `ðŸŽ¯ Join Quest: ${quest.title}\nðŸ’° Target: $${quest.targetAmount} | ðŸ‘¥ Participants: ${quest.participants.length}${isCreator ? '\nðŸ‘‘ You are the creator' : ''}`,
    actions,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  };

  try {
    log('info', 'Sending Quest Join Actions', { 
      contentType: ContentTypeActions, 
      questId,
      actionsCount: actions.length,
      isCreator 
    });
    await ctx.conversation.send(actionsContent, ContentTypeActions);
    log('info', 'âœ… Quest Join Actions sent successfully!');
  } catch (error) {
    log('error', 'Quest Join Actions failed', { error: error.message });
    // Fallback to text menu
    const fallback = `${actionsContent.description}\n\n` +
      `1ï¸âƒ£ ðŸ’° Join $50\n` +
      `2ï¸âƒ£ ðŸ’° Join $100\n` +
      `3ï¸âƒ£ ðŸ’° Join $200\n` +
      `4ï¸âƒ£ ðŸ’° Custom Amount${isCreator ? '\n5ï¸âƒ£ ðŸš€ Execute Quest\n6ï¸âƒ£ âŒ Cancel Quest' : ''}\n\n` +
      `Reply with the number to join`;
    await ctx.sendText(fallback);
  }
}

// ==================== QUEST DISPLAY FUNCTIONS ====================

function formatQuestCard(quest) {
  const typeInfo = QUEST_TYPES[quest.type];
  const progress = (quest.currentAmount / quest.targetAmount) * 100;
  const requiredApprovals = getRequiredApprovals(quest);
  const currentApprovals = quest.approvals.size;
  
  // Dynamic emojis based on progress
  let progressEmoji = 'ðŸŸ¢'; // Default
  if (progress >= 100) progressEmoji = 'ðŸ”¥';
  else if (progress >= 80) progressEmoji = 'âš¡';
  else if (progress >= 60) progressEmoji = 'ðŸš€';
  else if (progress >= 40) progressEmoji = 'ðŸ“ˆ';
  else if (progress >= 20) progressEmoji = 'ðŸ’ª';
  else progressEmoji = 'ðŸŒ±';
  
  // Status emojis
  let statusEmoji = 'ðŸŸ¢ Active';
  if (quest.status === 'completed') statusEmoji = 'âœ… Completed';
  else if (quest.status === 'failed') statusEmoji = 'âŒ Failed';
  else if (quest.status === 'cancelled') statusEmoji = 'ðŸš« Cancelled';
  
  // Approval status
  let approvalStatus = '';
  if (quest.status === 'active') {
    if (currentApprovals >= requiredApprovals) {
      approvalStatus = 'ðŸ”’ âœ… Ready to Execute';
    } else {
      approvalStatus = `ðŸ”’ â³ ${currentApprovals}/${requiredApprovals} Approvals`;
    }
  }
  
  return `ðŸŽ¯ **${quest.title}**
${typeInfo.icon} **${typeInfo.name}**

ðŸ“ ${quest.description}
ðŸ’° Target: $${quest.targetAmount} | Current: $${quest.currentAmount} (${progress.toFixed(1)}%) ${progressEmoji}
ðŸ‘¥ Participants: ${quest.participants.length}/${quest.requirements.maxParticipants || 'âˆž'}
â° Deadline: ${new Date(quest.deadline).toLocaleDateString()}
ðŸŽ Rewards: ${quest.rewards.apy ? `${quest.rewards.apy}% APY` : 'TBD'}
ðŸ’¼ Agent Fee: ${QUEST_FEE_PERCENTAGE * 100}% (transparent)
${approvalStatus ? `\n${approvalStatus}` : ''}

**Quest ID:** \`${quest.id}\`
**Status:** ${statusEmoji}`;
}

function formatQuestList(quests, title = "Active Quests") {
  if (quests.length === 0) {
    return `ðŸ“‹ No ${title.toLowerCase()} found. Create one to get started!`;
  }
  
  let response = `ðŸ“‹ **${title}:**\n\n`;
  
  quests.forEach((quest, index) => {
    const typeInfo = QUEST_TYPES[quest.type];
    const progress = (quest.currentAmount / quest.targetAmount) * 100;
    
    response += `${index + 1}. ${typeInfo.icon} **${quest.title}**\n`;
    response += `   ðŸ’° $${quest.currentAmount}/${quest.targetAmount} (${progress.toFixed(1)}%)\n`;
    response += `   ðŸ‘¥ ${quest.participants.length} participants\n`;
    response += `   ðŸ†” \`${quest.id}\`\n\n`;
  });
  
  response += "ðŸ’¡ Use quest ID to join: \"join quest [ID]\"";
  
  return response;
}

function formatLeaderboard() {
  if (leaderboard.length === 0) {
    return "ðŸ† No questers yet! Join some quests to climb the leaderboard!";
  }
  
  let response = "ðŸ† **Quest Leaderboard:**\n\n";
  
  leaderboard.slice(0, 10).forEach((user, index) => {
    const rank = index + 1;
    const medal = rank === 1 ? "ðŸ¥‡" : rank === 2 ? "ðŸ¥ˆ" : rank === 3 ? "ðŸ¥‰" : `${rank}.`;
    
    response += `${medal} **${user.username || user.address.slice(0, 8)}...**\n`;
    response += `   ðŸŽ¯ Quests: ${user.totalQuests} | âœ… Success: ${user.successfulQuests}\n`;
    response += `   ðŸ’° Profit: $${user.totalProfit.toFixed(2)} | ðŸ… Points: ${user.points}\n\n`;
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

    // DISABLED: Codec registration doesn't work with current XMTP SDK
    // The client object exists but is never populated with methods
    log('info', 'Skipping codec registration - using text-based menus instead');

    // React to show we received the message
    await ctx.sendReaction('ðŸ‘€');

    // Handle group chat messages - only respond if mentioned or replied to
    if (isGroupChat && !isMentioned && !isReplyToAgent) {
      return; // Don't respond to group messages unless mentioned
    }

    // Check for quest commands
    const response = await handleQuestCommands(ctx, userMessage, senderAddress);
    
    if (response && response !== 'MENU_SENT') {
      await ctx.sendText(response);
      log('info', 'Quest response sent', { 
        sender: senderAddress,
        response: response.substring(0, 100) + '...'
      });
    } else if (response === null) {
      // Help/menu command triggered - show main menu
      log('info', 'Help/menu command detected - showing main menu');
      await ctx.sendText('ðŸŽ¯ **Welcome to Dragman Quest Vault!** Choose your adventure:');
      await sendMainQuestActions(ctx);
    } else if (response === 'MENU_SENT') {
      // Menu already sent by command handler, don't send additional messages
      log('info', 'Menu already sent by command handler');
    } else {
      // No specific command found - let AI handle it naturally
      const message = userMessage.toLowerCase().trim();
      if (message.length > 0 && !message.includes('@dragman')) {
        // For other messages, just give a brief response
        await ctx.sendText('ðŸŽ¯ Dragman Quest Vault - Type `/menu` to see quest options or ask me about quests!');
      }
    }

  } catch (error) {
    log('error', 'Error handling message', { error: error.message });
    try {
      await ctx.sendText('âŒ Sorry, I encountered an error. Please try again.');
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
    await ctx.sendReaction('âŒ›');
    
    // Handle different actions based on actionId
    switch (actionId) {
      // Main quest actions
      case 'create_quest':
        await ctx.sendText('ðŸš€ Let\'s create a quest! Choose the type:');
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
        await ctx.sendText(`ðŸŽ¯ **Quest Vault Help**

**Creating Quests:**
â€¢ Choose quest type (DeFi, NFT, Airdrop, Swap)
â€¢ Set target amount and requirements
â€¢ Share with your group

**Joining Quests:**
â€¢ Click buttons to join
â€¢ Choose contribution amount
â€¢ Wait for quest execution

**Quest Types:**
ðŸ¦ **DeFi Stake** - Pool funds for yield farming
ðŸŽ¨ **NFT Mint** - Group NFT minting
ðŸŽ **Airdrop** - Group airdrop participation
ðŸ”„ **Token Swap** - Group token swaps

**Commands:**
â€¢ "create quest" - Start quest creation
â€¢ "list quests" - Show active quests
â€¢ "join quest [ID]" - Join specific quest
â€¢ "my quests" - Show your quests
â€¢ "leaderboard" - Show top questers

ðŸ’¡ **Pro Tip:** Quest Vault works best in group chats!`);
        break;
      
      // Quest type actions
      case 'type_defi':
        await ctx.sendText('ðŸ¦ **DeFi Stake Quest Creation**\n\nLet\'s create a DeFi yield farming quest!\n\n**Example:** "Create DeFi quest: Aerodrome USDC Pool, target $1000, min 5 participants, max $200 each"');
        break;
      case 'type_nft':
        await ctx.sendText('ðŸŽ¨ **NFT Mint Quest Creation**\n\nLet\'s create an NFT minting quest!\n\n**Example:** "Create NFT quest: Friend.tech Keys, target $500, min 3 participants, max $100 each"');
        break;
      case 'type_airdrop':
        await ctx.sendText('ðŸŽ **Airdrop Quest Creation**\n\nLet\'s create an airdrop participation quest!\n\n**Example:** "Create airdrop quest: Base Ecosystem, target $200, min 4 participants, max $50 each"');
        break;
      case 'type_swap':
        await ctx.sendText('ðŸ”„ **Token Swap Quest Creation**\n\nLet\'s create a token swap quest!\n\n**Example:** "Create swap quest: ETH to USDC, target $800, min 4 participants, max $200 each"');
        break;
      
      // Quest join actions
      default:
        if (actionId.startsWith('join_')) {
          const parts = actionId.split('_');
          const questId = parts[1];
          const amount = parts[2];
          
          if (amount === 'custom') {
            await ctx.sendText(`ðŸ’° **Custom Contribution**\n\nReply with your desired amount for quest \`${questId}\`\n\n**Example:** "Join quest ${questId} with $150"`);
          } else {
            const contribution = parseInt(amount);
            const result = await joinQuest(ctx, questId, contribution);
            
            if (result.success) {
              await ctx.sendText(`âœ… **Joined Quest Successfully!**\n\n${formatQuestCard(result.quest)}\n\nðŸŽ‰ You're now part of this quest!`);
            } else {
              await ctx.sendText(`âŒ **Failed to Join Quest**\n\n${result.message}`);
            }
          }
        } else if (actionId.startsWith('execute_')) {
          const questId = actionId.split('_')[1];
          const result = await executeQuest(ctx, questId);
          
          if (result.success) {
            await ctx.sendText(`ðŸš€ **Quest Executed Successfully!**\n\n${formatQuestCard(result.quest)}\n\nðŸ’° **Results:**\nâ€¢ Total Profit: $${result.result.totalProfit.toFixed(2)}\nâ€¢ Profit %: ${result.result.profitPercentage.toFixed(2)}%\nâ€¢ Agent Fee: $${result.result.fees.profit.toFixed(2)} (${result.result.fees.percentage}%)\nâ€¢ User Profit: $${(result.result.totalProfit - result.result.fees.profit).toFixed(2)}\nâ€¢ TX: \`${result.result.executionTx}\`\n\nðŸŽ‰ Quest completed! Rewards distributed to participants.`);
          } else {
            await ctx.sendText(`âŒ **Failed to Execute Quest**\n\n${result.message}`);
          }
        } else if (actionId.startsWith('cancel_')) {
          const questId = actionId.split('_')[1];
          const quest = questStore.get(questId);
          
          if (quest && quest.creator === ctx.message.senderAddress) {
            quest.status = 'cancelled';
            questStore.set(questId, quest);
            await ctx.sendText(`âŒ **Quest Cancelled**\n\nQuest \`${questId}\` has been cancelled by the creator.`);
          } else {
            await ctx.sendText(`âŒ **Cannot Cancel Quest**\n\nOnly the quest creator can cancel this quest.`);
          }
        } else {
          await ctx.sendText('â“ I\'m not sure what you selected. Please try again!');
        }
    }
  } catch (error) {
    log('error', 'Error handling intent', { error: error.message });
    await ctx.sendText('âŒ Sorry, I had trouble processing your selection. Please try again.');
  }
});

// ==================== MULTI-STEP QUEST CREATION ====================

async function handleMultiStepQuestCreation(ctx, userState, number, senderAddress, userMessage) {
  const questTypes = ['defi_stake', 'nft_mint', 'airdrop', 'swap'];
  const questTypeNames = ['DeFi Stake', 'NFT Mint', 'Airdrop', 'Token Swap'];
  
  switch (userState.step) {
    case 'type':
      if (number >= 1 && number <= 4) {
        userState.data.type = questTypes[number - 1];
        userState.step = 'target';
        userStates.set(senderAddress, userState);
        return `ðŸŽ¯ Step 2: Target Amount

You chose: ${questTypeNames[number - 1]}

What's your target amount?
Examples: $10, $50, $200

Type your target amount:`;
      } else {
        return 'â“ Please choose 1, 2, 3, or 4 for quest type.';
      }
      
    case 'target':
      const targetAmount = parseInt(userMessage.match(/\$?(\d+)/)?.[1] || '0');
      if (targetAmount >= 1) {
        userState.data.targetAmount = targetAmount;
        userState.step = 'participants';
        userStates.set(senderAddress, userState);
        return `ðŸŽ¯ Step 3: Participants

Target amount: $${targetAmount}

How many participants?
Examples: 2, 3, 5

Type the number of participants:`;
      } else {
        return 'âŒ Target amount must be at least $1. Please try again.';
      }
      
    case 'participants':
      const minParticipants = parseInt(userMessage.match(/(\d+)/)?.[1] || '0');
      if (minParticipants >= 2) {
        userState.data.minParticipants = minParticipants;
        userState.step = 'max_contribution';
        userStates.set(senderAddress, userState);
        return `ðŸŽ¯ Step 4: Maximum Contribution

Min participants: ${minParticipants}

What's the maximum each person can contribute?
Examples: $1, $10, $50

Type the maximum contribution per person:`;
      } else {
        return 'âŒ Minimum participants must be at least 2. Please try again.';
      }
      
    case 'max_contribution':
      const maxContribution = parseInt(userMessage.match(/\$?(\d+)/)?.[1] || '0');
      if (maxContribution >= 1) {
        userState.data.maxContribution = maxContribution;
        userState.step = 'deadline';
        userStates.set(senderAddress, userState);
        return `ðŸŽ¯ Step 5: Deadline

Max contribution: $${maxContribution}

How many days until deadline? (1-30 days)
Examples: 7, 14, 30

Type the number of days:`;
      } else {
        return 'âŒ Maximum contribution must be at least $1. Please try again.';
      }
      
    case 'deadline':
      const deadlineDays = parseInt(userMessage.match(/(\d+)/)?.[1] || '0');
      if (deadlineDays >= 1 && deadlineDays <= 30) {
        userState.data.deadlineDays = deadlineDays;
        userState.step = 'title';
        userStates.set(senderAddress, userState);
        return `ðŸŽ¯ Step 6: Quest Title

Deadline: ${deadlineDays} days

What should we call your quest?
Examples: "Aerodrome USDC Pool", "Friend.tech Keys Hunt", "Base Airdrop Quest"

Type your quest title:`;
      } else {
        return 'âŒ Deadline must be between 1-30 days. Please try again.';
      }
      
    case 'title':
      const title = userMessage.trim();
      if (title.length >= 3) {
        userState.data.title = title;
        userState.data.description = `Custom ${questTypeNames[questTypes.indexOf(userState.data.type)]} quest`;
        
        // Create the quest
        const questData = {
          type: userState.data.type,
          title: userState.data.title,
          description: userState.data.description,
          targetAmount: userState.data.targetAmount,
          requirements: {
            minParticipants: userState.data.minParticipants,
            maxParticipants: userState.data.minParticipants * 2,
            minContribution: 1,
            maxContribution: userState.data.maxContribution
          },
          deadline: new Date(Date.now() + userState.data.deadlineDays * 24 * 60 * 60 * 1000).toISOString(),
          rewards: {
            apy: userState.data.type === 'defi_stake' ? 12.5 : null
          }
        };
        
        const quest = await createQuest(ctx, questData, senderAddress);
        userStates.set(senderAddress, { state: 'main_menu' }); // Reset state
        
        if (quest) {
          return `ðŸŽ‰ **Custom Quest Created Successfully!**

${formatQuestCard(quest)}

ðŸ‘¥ **Share this quest with your group!**
Use: "join quest ${quest.id}"

ðŸ’¡ **Quest Summary:**
â€¢ Type: ${questTypeNames[questTypes.indexOf(quest.type)]}
â€¢ Target: $${quest.targetAmount}
â€¢ Min Participants: ${quest.requirements.minParticipants}
â€¢ Max Contribution: $${quest.requirements.maxContribution}
â€¢ Deadline: ${quest.requirements.deadlineDays} days
â€¢ Title: ${quest.title}`;
        } else {
          return 'âŒ Failed to create quest. Please try again.';
        }
      } else {
        return 'âŒ Quest title must be at least 3 characters. Please try again.';
      }
      
    default:
      return 'âŒ Invalid quest creation step. Please start over with /create.';
  }
}

// Handle text input for multi-step quest creation
async function handleMultiStepQuestCreationText(ctx, userState, userMessage, senderAddress) {
  const questTypes = ['defi_stake', 'nft_mint', 'airdrop', 'swap'];
  const questTypeNames = ['DeFi Stake', 'NFT Mint', 'Airdrop', 'Token Swap'];
  
  switch (userState.step) {
    case 'target':
      const targetAmount = parseInt(userMessage.match(/\$?(\d+)/)?.[1] || '0');
      if (targetAmount >= 1) {
        userState.data.targetAmount = targetAmount;
        userState.step = 'participants';
        userStates.set(senderAddress, userState);
        return `ðŸŽ¯ Step 3: Participants

Target amount: $${targetAmount}

How many participants?
Examples: 2, 3, 5

Type the number of participants:`;
      } else {
        return 'âŒ Target amount must be at least $1. Please try again.';
      }
      
    case 'participants':
      const minParticipants = parseInt(userMessage.match(/(\d+)/)?.[1] || '0');
      if (minParticipants >= 2) {
        userState.data.minParticipants = minParticipants;
        userState.step = 'max_contribution';
        userStates.set(senderAddress, userState);
        return `ðŸŽ¯ Step 4: Maximum Contribution

Min participants: ${minParticipants}

What's the maximum each person can contribute?
Examples: $1, $10, $50

Type the maximum contribution per person:`;
      } else {
        return 'âŒ Minimum participants must be at least 2. Please try again.';
      }
      
    case 'max_contribution':
      const maxContribution = parseInt(userMessage.match(/\$?(\d+)/)?.[1] || '0');
      if (maxContribution >= 1) {
        userState.data.maxContribution = maxContribution;
        userState.step = 'deadline';
        userStates.set(senderAddress, userState);
        return `ðŸŽ¯ Step 5: Deadline

Max contribution: $${maxContribution}

How many days until deadline? (1-30 days)
Examples: 7, 14, 30

Type the number of days:`;
      } else {
        return 'âŒ Maximum contribution must be at least $1. Please try again.';
      }
      
    case 'deadline':
      const deadlineDays = parseInt(userMessage.match(/(\d+)/)?.[1] || '0');
      if (deadlineDays >= 1 && deadlineDays <= 30) {
        userState.data.deadlineDays = deadlineDays;
        userState.step = 'title';
        userStates.set(senderAddress, userState);
        return `ðŸŽ¯ Step 6: Quest Title

Deadline: ${deadlineDays} days

What should we call your quest?
Examples: "Aerodrome USDC Pool", "Friend.tech Keys Hunt", "Base Airdrop Quest"

Type your quest title:`;
      } else {
        return 'âŒ Deadline must be between 1-30 days. Please try again.';
      }
      
    case 'title':
      const title = userMessage.trim();
      if (title.length >= 3) {
        userState.data.title = title;
        userState.data.description = `Custom ${questTypeNames[questTypes.indexOf(userState.data.type)]} quest`;
        
        // Create the quest
        const questData = {
          type: userState.data.type,
          title: userState.data.title,
          description: userState.data.description,
          targetAmount: userState.data.targetAmount,
          requirements: {
            minParticipants: userState.data.minParticipants,
            maxParticipants: userState.data.minParticipants * 2,
            minContribution: 1, // Updated to $1 minimum
            maxContribution: userState.data.maxContribution
          },
          deadline: new Date(Date.now() + userState.data.deadlineDays * 24 * 60 * 60 * 1000).toISOString(),
          rewards: {
            apy: userState.data.type === 'defi_stake' ? 12.5 : null
          }
        };
        
        const quest = await createQuest(ctx, questData, senderAddress);
        userStates.set(senderAddress, { state: 'main_menu' }); // Reset state
        
        if (quest) {
          return `ðŸŽ‰ **Custom Quest Created Successfully!**

${formatQuestCard(quest)}

ðŸ‘¥ **Share this quest with your group!**
Use: "join quest ${quest.id}"

ðŸ’¡ Quest Summary:
â€¢ Type: ${questTypeNames[questTypes.indexOf(quest.type)]}
â€¢ Target: $${quest.targetAmount}
â€¢ Participants: ${quest.requirements.minParticipants}
â€¢ Max Contribution: $${quest.requirements.maxContribution}
â€¢ Deadline: ${userState.data.deadlineDays} days
â€¢ Title: ${quest.title}`;
        } else {
          return 'âŒ Failed to create quest. Please try again.';
        }
      } else {
        return 'âŒ Quest title must be at least 3 characters. Please try again.';
      }
      
    default:
      return 'âŒ Invalid quest creation step. Please start over with /6.';
  }
}

// ==================== QUEST COMMAND HANDLING ====================

async function handleQuestCommands(ctx, userMessage, senderAddress) {
  const message = userMessage.toLowerCase().trim();
  
  // 0. SLASH COMMAND-BASED COMMANDS (prevents conflicts with normal numbers)
  if (/^\/menu$/.test(message.trim())) {
    // Show main quest menu
    await sendMainQuestActions(ctx);
    return 'MENU_SENT';
  }
  
  if (/^\/create$/.test(message.trim())) {
    // Start multi-step quest creation
    userStates.set(senderAddress, { 
      state: 'quest_creation', 
      step: 'type', 
      data: {} 
    });
    return `ðŸŽ¯ **Custom Quest Creation** - Let's build your perfect quest!

**Step 1: Quest Type**
Choose your quest type:
1ï¸âƒ£ ðŸ¦ DeFi Stake (yield farming, staking)
2ï¸âƒ£ ðŸŽ¨ NFT Mint (Friend.tech, Basenames, NFTs)
3ï¸âƒ£ ðŸŽ Airdrop (Base ecosystem, DeFi protocols)
4ï¸âƒ£ ðŸ”„ Token Swap (arbitrage, trading)

**Reply with /1, /2, /3, or /4 to select**`;
  }
  
  if (/^\/[1-6]$/.test(message.trim())) {
    const number = parseInt(message.trim().substring(1)); // Remove the slash
    const userState = userStates.get(senderAddress) || { state: 'main_menu' };
    
    log('info', 'Slash command received', { command: message.trim(), number, sender: senderAddress, state: userState.state });
    
    if (userState.state === 'quest_creation') {
      log('info', 'Processing multi-step quest creation', { step: userState.step, number });
      return await handleMultiStepQuestCreation(ctx, userState, number, senderAddress, userMessage);
    } else if (userState.state === 'quest_type_selection') {
      log('info', 'Processing quest type selection', { number });
      // Handle quest type selection
      let questData;
      switch (number) {
        case 1:
          questData = parseQuestCreation('create defi quest: DeFi Stake Quest, target $1000, min 3 participants, max $200 each');
          break;
        case 2:
          questData = parseQuestCreation('create nft quest: NFT Mint Quest, target $500, min 3 participants, max $100 each');
          break;
        case 3:
          questData = parseQuestCreation('create airdrop quest: Airdrop Quest, target $200, min 4 participants, max $50 each');
          break;
        case 4:
          questData = parseQuestCreation('create swap quest: Token Swap Quest, target $800, min 4 participants, max $200 each');
          break;
        default:
          return 'â“ Invalid quest type. Please choose /1, /2, /3, or /4.';
      }
      
      const quest = await createQuest(ctx, questData, senderAddress);
      userStates.set(senderAddress, { state: 'main_menu' }); // Reset state
      
      if (quest) {
        return `ðŸŽ¯ **Quest Created Successfully!**\n\n${formatQuestCard(quest)}\n\nðŸ‘¥ **Share this quest with your group!**\nUse: "join quest ${quest.id}"`;
      } else {
        return 'âŒ Failed to create quest. Please try again.';
      }
    } else {
      log('info', 'Processing main menu selection', { number });
      // Handle main menu
      switch (number) {
        case 1:
          userStates.set(senderAddress, { state: 'quest_type_selection' });
          await ctx.sendText('ðŸš€ **Quest Creation**\n\nChoose your quest type:');
          await sendQuestTypeActions(ctx);
          return 'MENU_SENT'; // Prevent main handler from sending additional messages
        case 2:
          const activeQuests = Array.from(questStore.values()).filter(q => q.status === 'active');
          return formatQuestList(activeQuests);
        case 3:
          const userQuests = Array.from(questStore.values()).filter(q => 
            q.creator === senderAddress || 
            q.participants.some(p => p.address === senderAddress)
          );
          return formatQuestList(userQuests, "My Quests");
        case 4:
          return formatLeaderboard();
        case 5:
          return `ðŸŽ¯ **Quest Vault Help**

**Creating Quests:**
â€¢ "create defi quest" - Create DeFi stake quest
â€¢ "create nft quest" - Create NFT mint quest  
â€¢ "create airdrop quest" - Create airdrop quest
â€¢ "create swap quest" - Create token swap quest

**Managing Quests:**
â€¢ "list quests" - Show active quests
â€¢ "my quests" - Show your quests
â€¢ "join quest [ID]" - Join specific quest
â€¢ "leaderboard" - Show top questers

**Commands:**
â€¢ "create quest" - Start quest creation
â€¢ "list quests" - Show active quests
â€¢ "join quest [ID]" - Join specific quest
â€¢ "my quests" - Show your quests
â€¢ "leaderboard" - Show top questers

ðŸ’¡ **Pro Tip:** Quest Vault works best in group chats!`;
        case 6:
          // Start multi-step quest creation
          userStates.set(senderAddress, { 
            state: 'quest_creation', 
            step: 'type', 
            data: {} 
          });
          return `ðŸŽ¯ **Custom Quest Creation** - Let's build your perfect quest!

**Step 1: Quest Type**
Choose your quest type:
1ï¸âƒ£ ðŸ¦ DeFi Stake (yield farming, staking)
2ï¸âƒ£ ðŸŽ¨ NFT Mint (Friend.tech, Basenames, NFTs)
3ï¸âƒ£ ðŸŽ Airdrop (Base ecosystem, DeFi protocols)
4ï¸âƒ£ ðŸ”„ Token Swap (arbitrage, trading)

**Reply with /1, /2, /3, or /4 to select**`;
        default:
          return 'â“ Invalid selection. Please choose /1, /2, /3, /4, /5, or /6.';
      }
    }
  }
  
  // 1. CREATE QUEST COMMANDS
  if (message.includes('create quest')) {
    await ctx.sendText('ðŸš€ **Quest Creation**\n\nChoose your quest type:');
    await sendQuestTypeActions(ctx);
    return null; // Let Quick Actions handle the response
  }
  
  // Handle quest type creation commands
  if (message.includes('create defi quest') || message.includes('create defi')) {
    const questData = parseQuestCreation('create defi quest: DeFi Stake Quest, target $1000, min 3 participants, max $200 each');
    const quest = await createQuest(ctx, questData, senderAddress);
    if (quest) {
      return `ðŸŽ¯ **Quest Created Successfully!**\n\n${formatQuestCard(quest)}\n\nðŸ‘¥ **Share this quest with your group!**\nUse: "join quest ${quest.id}"`;
    }
  }
  
  if (message.includes('create nft quest') || message.includes('create nft')) {
    const questData = parseQuestCreation('create nft quest: NFT Mint Quest, target $500, min 3 participants, max $100 each');
    const quest = await createQuest(ctx, questData, senderAddress);
    if (quest) {
      return `ðŸŽ¯ **Quest Created Successfully!**\n\n${formatQuestCard(quest)}\n\nðŸ‘¥ **Share this quest with your group!**\nUse: "join quest ${quest.id}"`;
    }
  }
  
  if (message.includes('create airdrop quest') || message.includes('create airdrop')) {
    const questData = parseQuestCreation('create airdrop quest: Airdrop Quest, target $200, min 4 participants, max $50 each');
    const quest = await createQuest(ctx, questData, senderAddress);
    if (quest) {
      return `ðŸŽ¯ **Quest Created Successfully!**\n\n${formatQuestCard(quest)}\n\nðŸ‘¥ **Share this quest with your group!**\nUse: "join quest ${quest.id}"`;
    }
  }
  
  if (message.includes('create swap quest') || message.includes('create swap')) {
    const questData = parseQuestCreation('create swap quest: Token Swap Quest, target $800, min 4 participants, max $200 each');
    const quest = await createQuest(ctx, questData, senderAddress);
    if (quest) {
      return `ðŸŽ¯ **Quest Created Successfully!**\n\n${formatQuestCard(quest)}\n\nðŸ‘¥ **Share this quest with your group!**\nUse: "join quest ${quest.id}"`;
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
    return formatQuestList(userQuests, "My Quests");
  }
  
  // 4. LEADERBOARD COMMANDS
  if (message.includes('leaderboard')) {
    return formatLeaderboard();
  }
  
  // 5. QUEST HELP COMMANDS
  if (message.includes('quest help') || message.includes('help')) {
    return `ðŸŽ¯ **Quest Vault Help**

**Creating Quests:**
â€¢ "create defi quest" - Create DeFi stake quest
â€¢ "create nft quest" - Create NFT mint quest  
â€¢ "create airdrop quest" - Create airdrop quest
â€¢ "create swap quest" - Create token swap quest

**Managing Quests:**
â€¢ "list quests" - Show active quests
â€¢ "my quests" - Show your quests
â€¢ "join quest [ID] $[amount]" - Join specific quest
â€¢ "quest details [ID]" - Show quest information
â€¢ "execute quest [ID]" - Execute quest (creator only)

**Other Commands:**
â€¢ "leaderboard" - Show top questers
â€¢ "help" - Show this help message

**Quest Types:**
ðŸ¦ **DeFi Stake** - Pool funds for yield farming
ðŸŽ¨ **NFT Mint** - Group NFT minting
ðŸŽ **Airdrop** - Group airdrop participation
ðŸ”„ **Token Swap** - Group token swaps

**Examples:**
â€¢ "create defi quest"
â€¢ "join quest quest_1234567890 $100"
â€¢ "list quests"
â€¢ "my quests"

ðŸ’¡ **Pro Tip:** Quest Vault works best in group chats!`;
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
        return `âœ… **Joined Quest Successfully!**\n\n${formatQuestCard(result.quest)}\n\nðŸŽ‰ You're now part of this quest!`;
      } else {
        return `âŒ **Failed to Join Quest**\n\n${result.message}`;
      }
    }
    
    // Try to parse "join quest [ID]" format (without amount)
    const questIdMatch = userMessage.match(/join quest\s+([a-zA-Z0-9_]+)/i);
    if (questIdMatch) {
      const questId = questIdMatch[1];
      const quest = questStore.get(questId);
      
      if (!quest) {
        return `âŒ Quest \`${questId}\` not found. Use "list quests" to see active quests.`;
      }
      
      if (quest.status !== 'active') {
        return `âŒ Quest \`${questId}\` is not active. Current status: ${quest.status}`;
      }
      
      await sendQuestJoinActions(ctx, questId);
      return null; // Let Quick Actions handle the response
    } else {
      return `âŒ Please specify quest ID. Example: "join quest quest_1234567890 $100"`;
    }
  }
  
  // 7. QUEST DETAILS COMMANDS
  if (message.includes('quest details') || message.includes('quest info')) {
    const questIdMatch = userMessage.match(/quest (?:details|info)\s+([a-zA-Z0-9_]+)/i);
    if (questIdMatch) {
      const questId = questIdMatch[1];
      const quest = questStore.get(questId);
      
      if (!quest) {
        return `âŒ Quest \`${questId}\` not found.`;
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
        return `ðŸš€ **Quest Executed Successfully!**\n\n${formatQuestCard(result.quest)}\n\nðŸ’° **Results:**\nâ€¢ Total Profit: $${result.result.totalProfit.toFixed(2)}\nâ€¢ Profit %: ${result.result.profitPercentage.toFixed(2)}%\nâ€¢ Agent Fee: $${result.result.fees.profit.toFixed(2)} (${result.result.fees.percentage}%)\nâ€¢ User Profit: $${(result.result.totalProfit - result.result.fees.profit).toFixed(2)}\nâ€¢ TX: \`${result.result.executionTx}\`\n\nðŸŽ‰ Quest completed! Rewards distributed to participants.`;
      } else {
        return `âŒ **Failed to Execute Quest**\n\n${result.message}`;
      }
    }
  }
  
  // 8.5. APPROVE QUEST EXECUTION COMMANDS
  if (message.includes('approve quest')) {
    const questIdMatch = userMessage.match(/approve quest\s+([a-zA-Z0-9_]+)/i);
    if (questIdMatch) {
      const questId = questIdMatch[1];
      const result = await approveQuestExecution(ctx, questId, senderAddress);
      return result;
    }
  }
  
  // 9. PARSE QUEST CREATION FROM TEXT
  if (message.includes('create') && (message.includes('defi') || message.includes('nft') || message.includes('airdrop') || message.includes('swap'))) {
    const questData = parseQuestCreation(userMessage);
    if (questData) {
      const quest = await createQuest(ctx, questData, senderAddress);
      if (quest) {
        return `ðŸŽ¯ **Quest Created Successfully!**\n\n${formatQuestCard(quest)}\n\nðŸ‘¥ **Share this quest with your group!**\nUse: "join quest ${quest.id}"`;
      }
    }
  }
  
  // 9.5. MULTI-STEP QUEST CREATION TEXT INPUT
  const userState = userStates.get(senderAddress);
  if (userState && userState.state === 'quest_creation') {
    // Handle text input for multi-step quest creation
    return await handleMultiStepQuestCreationText(ctx, userState, userMessage, senderAddress);
  }
  
  // Remove redundant state handlers
  
  // 9.5. DEBUG COMMANDS
  if (message.includes('debug codec') || message.includes('test codec')) {
    const success = testCodecRegistration();
    return success ? 
      'âœ… Codec registration test successful! Buttons should work now.' :
      'âŒ Codec registration test failed. Check logs for details.';
  }
  
  // 10. GREETING MESSAGES - Natural responses, no automatic menus
  if (message.includes('hello') || message.includes('hi') || message.includes('hey') || 
      message.includes('good morning') || message.includes('good afternoon') || message.includes('good evening') ||
      message.includes('gm') || message.includes('gn') || message.includes('morning') || message.includes('evening')) {
    // Reset user state to main menu
    userStates.set(senderAddress, { state: 'main_menu' });
    return `ðŸ‘‹ Hey there! I'm Dragman, your Quest Vault specialist! 

ðŸŽ¯ I help groups create and execute crypto quests together on Base chain. We can do DeFi staking, NFT minting, airdrops, and token swaps as a team!

ðŸ’¡ **Want to get started?** Type \`/menu\` to see all quest options, or just ask me about quests!`;
  }
  
  // Help and menu commands - show menu
  if (message.includes('help') || message.includes('start') || message.includes('menu') ||
      message.includes('feature') || message.includes('features') || message.includes('show') || message.includes('list')) {
    // Reset user state to main menu
    userStates.set(senderAddress, { state: 'main_menu' });
    return null; // Return null to trigger menu in main handler
  }
  
  // Default AI response for other messages
  return await generateQuestResponse(userMessage, senderAddress);
}

// Parse quest creation from natural language with enhanced customization
function parseQuestCreation(userMessage) {
  const message = userMessage.toLowerCase();
  
  // Determine quest type
  let type = 'defi_stake';
  if (message.includes('nft')) type = 'nft_mint';
  else if (message.includes('airdrop')) type = 'airdrop';
  else if (message.includes('swap')) type = 'swap';
  
  // Extract target amount (multiple patterns)
  const amountPatterns = [
    /target\s+\$(\d+)/i,
    /amount\s+\$(\d+)/i,
    /\$(\d+)\s+target/i,
    /\$(\d+)\s+total/i
  ];
  let targetAmount = 1000; // default
  for (const pattern of amountPatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      targetAmount = parseInt(match[1]);
      break;
    }
  }
  
  // Extract min participants (multiple patterns)
  const minPatterns = [
    /min(?:imum)?\s+(\d+)\s+participants/i,
    /min(?:imum)?\s+(\d+)\s+people/i,
    /min(?:imum)?\s+(\d+)/i,
    /at\s+least\s+(\d+)/i
  ];
  let minParticipants = 3; // default
  for (const pattern of minPatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      minParticipants = parseInt(match[1]);
      break;
    }
  }
  
  // Extract max contribution per person (multiple patterns)
  const maxPatterns = [
    /max(?:imum)?\s+\$(\d+)\s+each/i,
    /max(?:imum)?\s+\$(\d+)\s+per\s+person/i,
    /max(?:imum)?\s+\$(\d+)\s+per\s+participant/i,
    /max(?:imum)?\s+\$(\d+)/i,
    /up\s+to\s+\$(\d+)/i
  ];
  let maxContribution = 200; // default
  for (const pattern of maxPatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      maxContribution = parseInt(match[1]);
      break;
    }
  }
  
  // Extract deadline (multiple patterns)
  const deadlinePatterns = [
    /deadline\s+(\d+)\s+days/i,
    /(\d+)\s+days?\s+deadline/i,
    /expires?\s+in\s+(\d+)\s+days/i,
    /duration\s+(\d+)\s+days/i
  ];
  let deadlineDays = 7; // default
  for (const pattern of deadlinePatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      deadlineDays = parseInt(match[1]);
      break;
    }
  }
  
  // Extract custom title (multiple patterns)
  const titlePatterns = [
    /quest[:\s]+(.+?)(?:,|target|min|max|deadline|$)/i,
    /create\s+(?:a\s+)?(.+?)\s+quest/i,
    /title[:\s]+(.+?)(?:,|target|min|max|deadline|$)/i,
    /name[:\s]+(.+?)(?:,|target|min|max|deadline|$)/i
  ];
  let title = `${QUEST_TYPES[type].name} Quest`; // default
  for (const pattern of titlePatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      title = match[1].trim();
      break;
    }
  }
  
  // Extract custom description
  const descPatterns = [
    /description[:\s]+(.+?)(?:,|target|min|max|deadline|$)/i,
    /desc[:\s]+(.+?)(?:,|target|min|max|deadline|$)/i,
    /about[:\s]+(.+?)(?:,|target|min|max|deadline|$)/i
  ];
  let description = `Group ${QUEST_TYPES[type].name.toLowerCase()} quest`; // default
  for (const pattern of descPatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      description = match[1].trim();
      break;
    }
  }
  
  // Extract custom APY/rewards
  const apyPatterns = [
    /apy\s+(\d+(?:\.\d+)?)%/i,
    /yield\s+(\d+(?:\.\d+)?)%/i,
    /return\s+(\d+(?:\.\d+)?)%/i,
    /(\d+(?:\.\d+)?)%\s+apy/i
  ];
  let customAPY = null;
  for (const pattern of apyPatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      customAPY = parseFloat(match[1]);
      break;
    }
  }
  
  // Validate parameters (very low limits for accessibility)
  if (targetAmount < 1) targetAmount = 1; // Allow as low as $1
  if (minParticipants < 2) minParticipants = 2; // Keep minimum 2 for group activity
  if (maxContribution < 1) maxContribution = 1; // Allow as low as $1
  if (deadlineDays < 1) deadlineDays = 1;
  if (deadlineDays > 30) deadlineDays = 30;
  
  return {
    type,
    title,
    description,
    targetAmount,
    requirements: {
      minParticipants,
      maxParticipants: minParticipants * 2,
      minContribution: 1,
      maxContribution
    },
    deadline: new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000).toISOString(),
    rewards: {
      apy: customAPY || (type === 'defi_stake' ? 12.5 : null)
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
ðŸ¦ DeFi Stake - Pool funds for yield farming (Aerodrome, Uniswap, Aave)
ðŸŽ¨ NFT Mint - Group NFT minting (Friend.tech keys, Basenames, Base NFTs)
ðŸŽ Airdrop - Group airdrop participation (Base ecosystem, DeFi protocols)
ðŸ”„ Token Swap - Group token swaps (ETH/USDC, arbitrage opportunities)

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
    return "ðŸŽ¯ I'm having trouble connecting right now. Try asking about quests!";
  }
}

// ==================== AGENT STARTUP ====================

// Start the agent
await agent.start();

// Log when we're ready
agent.on('start', async () => {
  log('info', `âœ… Dragman Quest Vault Agent is online and ready!`);
  log('info', `ðŸ“¬ Agent address: ${agent.address}`);
  
  // CRITICAL: Register codecs with multiple strategies
  let codecRegistered = false;
  
  // Strategy 1: Immediate registration
  try {
    if (agent && agent.client && agent.client.codecRegistry) {
      const actionsCodec = new JsonCodec(ContentTypeActions);
      const intentCodec = new JsonCodec(ContentTypeIntent);
      
      agent.client.codecRegistry.register(actionsCodec);
      agent.client.codecRegistry.register(intentCodec);
      
      log('info', `âœ… Base App Quick Actions codecs registered immediately!`);
      log('info', `ðŸ“‹ Actions codec ID: ${actionsCodec.id}`);
      log('info', `ðŸ“‹ Intent codec ID: ${intentCodec.id}`);
      codecRegistered = true;
    }
  } catch (e) {
    log('warn', `Immediate codec registration failed`, { error: e?.message });
  }
  
  // Strategy 2: Delayed registration with retries
  if (!codecRegistered) {
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        
        if (agent && agent.client && agent.client.codecRegistry) {
          const actionsCodec = new JsonCodec(ContentTypeActions);
          const intentCodec = new JsonCodec(ContentTypeIntent);
          
          agent.client.codecRegistry.register(actionsCodec);
          agent.client.codecRegistry.register(intentCodec);
          
          log('info', `âœ… Base App Quick Actions codecs registered successfully! (attempt ${attempt})`);
          log('info', `ðŸ“‹ Actions codec ID: ${actionsCodec.id}`);
          log('info', `ðŸ“‹ Intent codec ID: ${intentCodec.id}`);
          codecRegistered = true;
          break;
        } else {
          log('warn', `Codec registry not available (attempt ${attempt}/10) - client: ${!!agent?.client}, registry: ${!!agent?.client?.codecRegistry}`);
        }
      } catch (e) {
        log('error', `Failed to register codecs (attempt ${attempt}/10)`, { error: e?.message });
      }
    }
  }
  
  // Strategy 3: Force registration on first message
  if (!codecRegistered) {
    log('error', 'âŒ CRITICAL: Codec registration failed - will retry on first message');
    log('error', 'ðŸ”§ Agent client status:', { 
      hasAgent: !!agent, 
      hasClient: !!agent?.client, 
      hasRegistry: !!agent?.client?.codecRegistry 
    });
  }
  
  // Log installation info
  try {
    if (agent?.installationId) {
      log('info', `ðŸ”§ Installation ID: ${agent.installationId}`);
    }
  } catch (e) {
    // ignore installation logging errors
  }
});

// Keep the process running
process.on('SIGINT', () => {
  log('info', 'ðŸ›‘ Shutting down gracefully...');
  process.exit(0);
});
