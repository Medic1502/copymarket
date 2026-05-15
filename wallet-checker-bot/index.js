require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const fetch = require('node-fetch');

const BLUE         = 0x2563EB;
const GREEN        = 0x22C55E;
const RED          = 0xEF4444;
const YELLOW       = 0xF59E0B;
const ALLOWED_CHANNEL = 'wallet-checker';

if (!process.env.CHECKER_BOT_TOKEN || !process.env.CHECKER_CLIENT_ID) {
  console.error('Missing CHECKER_BOT_TOKEN or CHECKER_CLIENT_ID in .env');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── POLYMARKET API ────────────────────────────────────────────────────────────

async function getPositions(address) {
  const res = await fetch(`https://clob.polymarket.com/positions?user=${address}`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : (data.positions || data.data || []);
}

async function getActivity(address, limit = 100) {
  const res = await fetch(`https://data-api.polymarket.com/activity?user=${address}&limit=${limit}`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : (data.data || []);
}

function calcStats(activity) {
  let totalBought = 0, totalRedeemed = 0, trades = 0, wins = 0, losses = 0;
  for (const a of activity) {
    const type = (a.type || a.side || '').toUpperCase();
    const size = parseFloat(a.usdcSize || a.size || a.amount || 0);
    if (type === 'BUY' || type === 'TRADE') {
      totalBought += size;
      trades++;
    } else if (type === 'REDEEM') {
      totalRedeemed += size;
      if (size > 0) wins++;
    } else if (type === 'SELL') {
      totalRedeemed += size;
      trades++;
    }
  }
  const pnl = totalRedeemed - totalBought;
  const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : null;
  return { pnl, volume: totalBought, trades, winRate };
}

function shortAddr(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '—';
}

function pnlColor(pnl) {
  if (pnl > 0) return GREEN;
  if (pnl < 0) return RED;
  return BLUE;
}

function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toFixed(decimals);
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(1) + '%';
}

async function buildCheckerEmbed(address) {
  const [positions, activity] = await Promise.allSettled([
    getPositions(address),
    getActivity(address, 200),
  ]);

  const pos  = positions.status === 'fulfilled' ? positions.value : [];
  const acts = activity.status  === 'fulfilled' ? activity.value  : [];

  const stats   = calcStats(acts);
  const pnl     = stats.pnl;
  const volume  = stats.volume;
  const trades  = stats.trades;
  const winRate = stats.winRate;
  const followers = null;

  const color = pnlColor(pnl);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🔍 Polymarket Wallet Analysis')
    .setDescription(`**[${shortAddr(address)}](https://polymarket.com/profile/${address})**\n\`${address}\``)
    .addFields(
      { name: '💰 Total P&L',     value: fmt(pnl),                                    inline: true },
      { name: '📊 Win Rate',       value: winRate != null ? fmtPct(winRate) : '—',     inline: true },
      { name: '🔄 Total Trades',   value: trades > 0 ? trades.toString() : '—',        inline: true },
      { name: '💵 Volume Traded',  value: volume > 0 ? '$' + volume.toFixed(2) : '—', inline: true },
      { name: '📌 Open Positions', value: pos.length.toString(),                        inline: true },
      { name: '🔗 Profile',        value: `[View on Polymarket](https://polymarket.com/profile/${address})`, inline: true },
    );

  // Open positions
  if (pos.length > 0) {
    const posLines = pos.slice(0, 5).map(p => {
      const size = parseFloat(p.size || p.quantity || 0).toFixed(2);
      const outcome = p.outcome || 'Yes';
      const market = p.title || p.market_slug || p.conditionId?.slice(0, 20) || 'Unknown market';
      return `> **${outcome}** — $${size} · ${market.slice(0, 40)}`;
    }).join('\n');
    embed.addFields({ name: `📂 Open Positions (${pos.length})`, value: posLines || '—', inline: false });
  }

  // Recent activity
  if (acts.length > 0) {
    const actLines = acts.slice(0, 5).map(a => {
      const side = (a.type || a.side || '').toUpperCase();
      const size = parseFloat(a.size || a.amount || 0).toFixed(2);
      const market = a.title || a.market || 'Unknown';
      const icon = side === 'BUY' ? '🟢' : side === 'SELL' ? '🔴' : '⚪';
      return `> ${icon} **${side || '—'}** $${size} · ${market.slice(0, 35)}`;
    }).join('\n');
    embed.addFields({ name: '⚡ Recent Activity', value: actLines || '—', inline: false });
  }

  embed
    .setFooter({ text: `Jonin Polymarket Wallet Checker · ${shortAddr(address)}` })
    .setTimestamp();

  return embed;
}

// ── COMMANDS ──────────────────────────────────────────────────────────────────

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('check')
      .setDescription('Check any Polymarket wallet — P&L, win rate, positions, recent trades')
      .addStringOption(opt =>
        opt.setName('wallet')
          .setDescription('Polymarket wallet address (0x...)')
          .setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('top')
      .setDescription('Show info about using Jonin CT to copy top traders')
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.CHECKER_BOT_TOKEN);
  const guildId = process.env.CHECKER_GUILD_ID;

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(process.env.CHECKER_CLIENT_ID, guildId), { body: commands });
    console.log('Commands registered to guild (instant).');
  } else {
    await rest.put(Routes.applicationCommands(process.env.CHECKER_CLIENT_ID), { body: commands });
    console.log('Commands registered globally.');
  }
}

// ── EVENTS ────────────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`Jonin Wallet Checker online as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Only allow commands in #wallet-checker channel
  if (interaction.channel?.name !== ALLOWED_CHANNEL) {
    return interaction.reply({
      content: `❌ This command only works in <#${interaction.guild?.channels.cache.find(c => c.name === ALLOWED_CHANNEL)?.id || 'wallet-checker'}>.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── /check ────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'check') {
    const wallet = interaction.options.getString('wallet').trim();

    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return interaction.reply({
        content: '❌ Invalid wallet address. Must start with `0x` and be 42 characters long.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const embed = await buildCheckerEmbed(wallet);
      const ctEmbed = new EmbedBuilder()
        .setColor(BLUE)
        .setDescription('💡 **Like this trader?** Copy their trades automatically with **[Jonin CT](https://discord.gg/SxumcmKcEm)** — our automated copy trading bot for Polymarket.');

      await interaction.editReply({ embeds: [embed, ctEmbed] });
    } catch (err) {
      console.error('Check error:', err.message);
      await interaction.editReply({
        content: `❌ Could not fetch data for \`${wallet}\`.\nMake sure it's a valid Polymarket wallet address.`,
      });
    }
    return;
  }

  // ── /top ──────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'top') {
    const embed = new EmbedBuilder()
      .setColor(BLUE)
      .setTitle('⚡ Copy Top Polymarket Traders Automatically')
      .setDescription('Found a wallet worth following? **Jonin CT** copies every trade they make directly to your wallet — 24/7, hands-free.')
      .addFields(
        { name: '🔍 How to find good traders', value: 'Use `/check 0x...` to analyze any wallet. Look for:\n> ✅ Positive total P&L\n> ✅ Win rate above 55%\n> ✅ More than 50 trades\n> ✅ Active in the last 30 days', inline: false },
        { name: '🚀 Start copying', value: 'Join our Discord server, get **Premium CT** and start copying top traders automatically.', inline: false },
      )
      .setFooter({ text: 'Jonin CT — Copy. Track. Win.' });

    await interaction.reply({ embeds: [embed] });
    return;
  }
});

client.on('error', err => console.error('Client error:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err?.message));

client.login(process.env.CHECKER_BOT_TOKEN);
