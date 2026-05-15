require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const fetch = require('node-fetch');

const RAILWAY_URL  = process.env.RAILWAY_API_URL;
const BOT_SECRET   = process.env.DISCORD_BOT_SECRET;
const PREMIUM_ROLE = 'Premium CT';
const BLUE  = 0x2563EB;
const GREEN = 0x22C55E;
const RED   = 0xEF4444;

if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_CLIENT_ID || !RAILWAY_URL || !BOT_SECRET) {
  console.error('Missing required env vars.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

// ── EMBEDS ────────────────────────────────────────────────────────────────────

function welcomeEmbed(member) {
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('👋 Welcome to Jonin CT!')
    .setDescription(`Hey ${member}, glad to have you here!\n\nJonin CT is a **Polymarket trading suite** — check any trader's stats for free, or go premium and copy their trades automatically.`)
    .addFields(
      {
        name: '🆓 Free — Wallet Checker',
        value: 'Paste any Polymarket wallet address and instantly see their **P&L, win rate, trade history and open positions**. No account needed.',
        inline: false
      },
      {
        name: '⚡ Premium CT — Copy Trading',
        value: 'Found a trader worth following? Let Jonin CT **automatically copy every trade they make** — proportional to your budget, 24/7, hands-free.',
        inline: false
      },
      {
        name: '📌 Get started',
        value: '> 🔍 Use the free wallet checker in <#wallet-checker>\n> 💎 Get **Premium CT** to unlock copy trading\n> 🔑 Type `/getkey` to receive your license key\n> 📥 Download the app from <#downloads>',
        inline: false
      }
    )
    .setFooter({ text: 'Jonin CT — Copy. Track. Win.' })
    .setTimestamp();
}

function howItWorksEmbed() {
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('⚙️ How Jonin CT Works')
    .setDescription('Jonin CT runs on our servers 24/7 and monitors Polymarket in real time. Here\'s exactly what happens under the hood.')
    .addFields(
      {
        name: '📡 Real-time position monitoring',
        value: 'The bot continuously polls the Polymarket CLOB API every **15 seconds**, watching the open positions of every trader you follow. It detects the moment a trader opens or closes a position.',
        inline: false
      },
      {
        name: '⚡ Instant trade execution',
        value: 'The moment a signal is detected, the bot places an order on your behalf directly through the **Polymarket CLOB (Central Limit Order Book)**. Your order is signed with your private key and submitted on-chain on Polygon.',
        inline: false
      },
      {
        name: '📊 Proportional sizing',
        value: 'If a trader bets 10% of their portfolio, Jonin CT bets the same % of yours. You set the percentage or a fixed amount — the bot scales every trade accordingly. You never over-expose yourself.',
        inline: false
      },
      {
        name: '🔒 Fully isolated wallets',
        value: 'Every user has their own **dedicated Polygon wallet** generated and encrypted on our servers. Your funds never mix with other users. Your key, your wallet, your trades.',
        inline: false
      },
      {
        name: '🤝 Shared polling — efficient by design',
        value: 'If 100 users follow the same trader, Jonin CT makes **one API call** to Polymarket instead of 100. This keeps the system fast, avoids rate limits, and scales to hundreds of users without slowdown.',
        inline: false
      },
      {
        name: '🛡️ Filters & safety controls',
        value: 'You can filter by: minimum/maximum bet size, share price range, market category, and follow mode (all buys vs first entry only). The bot only copies trades that match your exact settings.',
        inline: false
      },
      {
        name: '⚠️ Risk notice',
        value: 'Prediction market trading involves risk of capital loss. Past performance of any trader does not guarantee future results. Only trade with funds you can afford to lose.',
        inline: false
      }
    )
    .setFooter({ text: 'Jonin CT — Copy. Track. Win.' });
}

function getRulesEmbed() {
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('📋 Server Rules')
    .setDescription('Please read and follow these rules to keep the community clean and helpful.')
    .addFields(
      { name: '1. Be respectful', value: 'No harassment, hate speech or personal attacks. Treat everyone with respect.', inline: false },
      { name: '2. No spam', value: 'Do not spam messages, emojis or pings. Keep conversations on-topic per channel.', inline: false },
      { name: '3. No sharing keys', value: 'License keys are personal and tied to your machine. Do not share or sell your key.', inline: false },
      { name: '4. No financial advice', value: 'Nothing shared here is financial advice. You are responsible for your own trades and losses.', inline: false },
      { name: '5. Use the right channels', value: 'Post in the correct channel. Use #support for help, #general for chat.', inline: false },
      { name: '6. No self-promotion', value: 'Do not promote other projects, bots or services without admin permission.', inline: false }
    )
    .setFooter({ text: 'Breaking rules may result in a mute or ban.' });
}

function setupGuideEmbed() {
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('🛠️ Setup Guide — Jonin CT')
    .setDescription('Follow these steps to get Jonin CT running and your first trader copied.')
    .addFields(
      {
        name: 'Step 1 — Get your license key',
        value: 'Type `/getkey` in <#get-key>. The bot will DM you your personal license key. You need the **Premium CT** role to do this.',
        inline: false
      },
      {
        name: 'Step 2 — Download the app',
        value: 'Go to <#downloads> and download the latest **Jonin CT Setup .exe**. Run the installer — it takes under 30 seconds.',
        inline: false
      },
      {
        name: 'Step 3 — Activate',
        value: 'Open Jonin CT. Paste your license key from the DM and click **Activate**. The app connects to our servers and logs you in automatically.',
        inline: false
      },
      {
        name: 'Step 4 — Fund your wallet',
        value: 'Go to the **Wallet** tab. Copy your deposit address and send **USDC on Polygon** to it.\n\n> Minimum to start copying: **$5 USDC**\n> Also works with Moonpay (buy by card directly)',
        inline: false
      },
      {
        name: 'Step 5 — Connect to Polymarket',
        value: 'Go to **Wallet → Export private key**, import it into MetaMask, then visit [polymarket.com](https://polymarket.com) and accept their Terms of Service. This is a one-time step required by Polymarket.',
        inline: false
      },
      {
        name: 'Step 6 — Add a trader',
        value: 'Go to **My Traders** → click **+ Add trader**. Paste the wallet address of a top Polymarket trader. Set your copy mode and click **Add trader**.',
        inline: false
      },
      {
        name: 'Step 7 — Start copying',
        value: 'Click **Resume** next to the trader. Jonin CT will now copy every trade they make in real time. You can monitor everything from the dashboard.',
        inline: false
      },
      {
        name: '❓ Need help?',
        value: 'Open a ticket in <#support> and an admin will assist you.',
        inline: false
      }
    )
    .setFooter({ text: 'Jonin CT — Copy. Track. Win.' });
}

function howToJoinEmbed() {
  return new EmbedBuilder()
    .setColor(GREEN)
    .setTitle('💎 How to Get Premium CT')
    .setDescription('Premium CT gives you full access to the Jonin CT copy trading platform. Here\'s how to get it.')
    .addFields(
      {
        name: '1️⃣  Purchase a subscription',
        value: 'Buy the **Premium CT** plan through our payment link. Once payment is confirmed you will be assigned the **Premium CT** role on this server automatically.',
        inline: false
      },
      {
        name: '2️⃣  Get your license key',
        value: 'Once you have the role, type `/getkey` in <#get-key>. The bot sends your personal key via DM. Keep it private — it\'s tied to your machine.',
        inline: false
      },
      {
        name: '3️⃣  Download & activate',
        value: 'Download the Jonin CT Desktop App from <#downloads>, paste your key and click **Activate**. Setup takes under 2 minutes.',
        inline: false
      },
      {
        name: '✅ What you get',
        value: '> ⚡ Automated 24/7 copy trading\n> 📊 Real-time P&L dashboard\n> 🔍 Free wallet checker\n> 🛡️ Your own isolated wallet\n> 🔔 Trade notifications\n> 💬 Priority support',
        inline: false
      },
      {
        name: '🔄 Switching machines?',
        value: 'Use `/shufflekey` to get a new key. Your old key is invalidated. One key per account, one machine at a time.',
        inline: false
      },
      {
        name: '❓ Questions?',
        value: 'Ask in <#support> or DM an admin. We\'re here to help.',
        inline: false
      }
    )
    .setFooter({ text: 'Jonin CT — Copy. Track. Win.' });
}

function getKeyInfoEmbed() {
  return new EmbedBuilder()
    .setColor(GREEN)
    .setTitle('🔑 How to Get Your License Key')
    .setDescription('Follow these steps to activate Jonin CT on your machine.')
    .addFields(
      { name: 'Step 1 — Make sure you have the role', value: 'You need the **Premium CT** role. Purchase a subscription to receive it.', inline: false },
      { name: 'Step 2 — Request your key', value: 'Type `/getkey` in this channel. The bot will send your key via **DM** (only you can see it).', inline: false },
      { name: 'Step 3 — Download the app', value: 'Go to <#downloads> and download the latest **Jonin CT Setup** installer.', inline: false },
      { name: 'Step 4 — Activate', value: 'Open the app → paste your key → click **Activate**. You\'re in.', inline: false },
      { name: '🔄 Switching machines?', value: 'Use `/shufflekey` to get a new key. Your old key becomes invalid.', inline: false },
      { name: '❓ Problems?', value: 'Open a ticket in <#support> and an admin will help you.', inline: false }
    )
    .setFooter({ text: 'One key per Discord account. Keys are tied to one machine at a time.' });
}

// ── COMMANDS ──────────────────────────────────────────────────────────────────

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('getkey')
      .setDescription('Get your Jonin CT license key (requires Premium CT role)')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('shufflekey')
      .setDescription('Generate a new license key — invalidates your old one (24h cooldown)')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('[Admin] Post Jonin CT info embeds to this channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(opt =>
        opt.setName('type')
          .setDescription('Which embed to post')
          .setRequired(true)
          .addChoices(
            { name: 'How it works', value: 'howitworks' },
            { name: 'Setup guide', value: 'setup' },
            { name: 'How to join (Premium CT)', value: 'howtojoin' },
            { name: 'Rules', value: 'rules' },
            { name: 'Get key info', value: 'getkey' },
            { name: 'Welcome', value: 'welcome' },
            { name: 'All', value: 'all' },
          )
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('announce')
      .setDescription('[Admin] Send a custom announcement embed')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(opt => opt.setName('title').setDescription('Title').setRequired(true))
      .addStringOption(opt => opt.setName('message').setDescription('Message body').setRequired(true))
      .addStringOption(opt =>
        opt.setName('color')
          .setDescription('Embed color')
          .addChoices(
            { name: 'Blue (default)', value: 'blue' },
            { name: 'Green (good news)', value: 'green' },
            { name: 'Red (important)', value: 'red' },
          )
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('revokekey')
      .setDescription('[Admin] Revoke a user license key')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(opt =>
        opt.setName('key').setDescription('License key UUID').setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('resetmachine')
      .setDescription('[Admin] Reset HWID so user can activate on a new machine')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(opt =>
        opt.setName('key').setDescription('License key UUID').setRequired(true)
      )
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  const guildId = process.env.DISCORD_GUILD_ID;
  if (guildId) {
    // Guild commands — instant, only on this server
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId), { body: commands });
    console.log('Slash commands registered to guild (instant).');
  } else {
    // Global commands — up to 1h propagation
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
    console.log('Slash commands registered globally.');
  }
}

// ── EVENTS ────────────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`Jonin CT Bot online as ${client.user.tag}`);
  await registerCommands();
});

// Welcome new members
client.on('guildMemberAdd', async (member) => {
  // DM the new member
  try {
    await member.send({ embeds: [welcomeEmbed(member)] });
  } catch {}

  // Post in #welcome channel if it exists
  const welcomeChannel = member.guild.channels.cache.find(
    c => c.name === 'welcome' || c.name === 'welcomes' || c.name === 'general'
  );
  if (welcomeChannel) {
    try {
      await welcomeChannel.send({
        content: `🎉 Welcome to the server, ${member}!`,
        embeds: [welcomeEmbed(member)],
      });
    } catch {}
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ── /getkey ──────────────────────────────────────────────────────────────
  if (interaction.commandName === 'getkey') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const hasPremiumRole = interaction.member.roles.cache.some(r => r.name === PREMIUM_ROLE);
    if (!hasPremiumRole) {
      return interaction.editReply({
        content: '❌ You need the **Premium CT** role to get a license key.\nPurchase a subscription to receive this role.',
      });
    }

    try {
      const resp = await fetch(`${RAILWAY_URL}/api/license/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BOT_SECRET}` },
        body: JSON.stringify({ discordUserId: interaction.user.id, discordUsername: interaction.user.username }),
      });
      if (!resp.ok) throw new Error(`Server ${resp.status}`);
      const data = await resp.json();

      const embed = new EmbedBuilder()
        .setColor(data.existing ? BLUE : GREEN)
        .setTitle(data.existing ? '🔑 Your License Key' : '🎉 License Key Generated!')
        .setDescription(data.existing
          ? 'This is your existing license key. Keep it private — it\'s tied to your machine after first use.'
          : 'Your key has been generated! Follow the steps below to activate Jonin CT.')
        .addFields(
          { name: 'License Key', value: `\`\`\`${data.key}\`\`\``, inline: false },
          { name: 'How to activate', value: '1. Download the app from #downloads\n2. Open Jonin CT\n3. Paste your key → click **Activate**', inline: false }
        )
        .setFooter({ text: '⚠️ Never share this key. It locks to your machine on first use.' });

      try {
        await interaction.user.send({ embeds: [embed] });
        await interaction.editReply({ content: '✅ Your license key has been sent to your DMs!' });
      } catch {
        await interaction.editReply({ content: `✅ Your key (enable DMs next time):\n\`\`\`${data.key}\`\`\`` });
      }
    } catch (err) {
      console.error('/getkey error:', err);
      await interaction.editReply({ content: '❌ Failed to generate key. Try again or contact support.' });
    }
    return;
  }

  // ── /shufflekey ───────────────────────────────────────────────────────────
  if (interaction.commandName === 'shufflekey') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const hasPremiumRole = interaction.member.roles.cache.some(r => r.name === PREMIUM_ROLE);
    if (!hasPremiumRole) return interaction.editReply({ content: '❌ You need the **Premium CT** role.' });

    try {
      const resp = await fetch(`${RAILWAY_URL}/api/license/shuffle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BOT_SECRET}` },
        body: JSON.stringify({ discordUserId: interaction.user.id }),
      });
      const data = await resp.json();
      if (data.cooldown) return interaction.editReply({ content: `⏳ ${data.error}` });
      if (!resp.ok || data.error) return interaction.editReply({ content: `❌ ${data.error || 'Failed.'}` });

      const embed = new EmbedBuilder()
        .setColor(BLUE)
        .setTitle('🔄 New Key Generated')
        .setDescription('Your old key has been invalidated. Use the new key below.')
        .addFields({ name: 'New License Key', value: `\`\`\`${data.key}\`\`\``, inline: false })
        .setFooter({ text: 'Open the app and enter your new key to activate.' });

      try {
        await interaction.user.send({ embeds: [embed] });
        await interaction.editReply({ content: '✅ New key sent to your DMs!' });
      } catch {
        await interaction.editReply({ content: `✅ New key:\n\`\`\`${data.key}\`\`\`` });
      }
    } catch (err) {
      await interaction.editReply({ content: '❌ Failed. Try again.' });
    }
    return;
  }

  // ── /setup ────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'setup') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const type = interaction.options.getString('type');
    const ch   = interaction.channel;

    try {
      if (type === 'howitworks' || type === 'all') await ch.send({ embeds: [howItWorksEmbed()] });
      if (type === 'setup'      || type === 'all') await ch.send({ embeds: [setupGuideEmbed()] });
      if (type === 'howtojoin'  || type === 'all') await ch.send({ embeds: [howToJoinEmbed()] });
      if (type === 'rules'      || type === 'all') await ch.send({ embeds: [getRulesEmbed()] });
      if (type === 'getkey'     || type === 'all') await ch.send({ embeds: [getKeyInfoEmbed()] });
      if (type === 'welcome')                       await ch.send({ embeds: [welcomeEmbed(interaction.member)] });
      await interaction.editReply({ content: `✅ Posted to ${ch}.` });
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed: ${err.message}` });
    }
    return;
  }

  // ── /announce ─────────────────────────────────────────────────────────────
  if (interaction.commandName === 'announce') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const title   = interaction.options.getString('title');
    const message = interaction.options.getString('message');
    const color   = interaction.options.getString('color') || 'blue';
    const colorMap = { blue: BLUE, green: GREEN, red: RED };

    const embed = new EmbedBuilder()
      .setColor(colorMap[color])
      .setTitle(title)
      .setDescription(message)
      .setTimestamp()
      .setFooter({ text: 'Jonin CT' });

    try {
      await interaction.channel.send({ content: '@everyone', embeds: [embed] });
      await interaction.editReply({ content: '✅ Announcement sent!' });
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed: ${err.message}` });
    }
    return;
  }

  // ── /revokekey ────────────────────────────────────────────────────────────
  if (interaction.commandName === 'revokekey') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const key = interaction.options.getString('key');
    try {
      const resp = await fetch(`${RAILWAY_URL}/api/license/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BOT_SECRET}` },
        body: JSON.stringify({ key }),
      });
      if (!resp.ok) throw new Error(`Server ${resp.status}`);
      await interaction.editReply({ content: `✅ Key \`${key}\` revoked.` });
    } catch (err) {
      await interaction.editReply({ content: '❌ Failed to revoke key.' });
    }
    return;
  }

  // ── /resetmachine ─────────────────────────────────────────────────────────
  if (interaction.commandName === 'resetmachine') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const key = interaction.options.getString('key');
    try {
      const resp = await fetch(`${RAILWAY_URL}/api/license/reset-hwid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BOT_SECRET}` },
        body: JSON.stringify({ key }),
      });
      if (!resp.ok) throw new Error(`Server ${resp.status}`);
      await interaction.editReply({ content: `✅ Machine reset for \`${key}\`. User can activate on a new device.` });
    } catch (err) {
      await interaction.editReply({ content: '❌ Failed to reset machine.' });
    }
    return;
  }
});

client.on('error', (err) => console.error('Discord client error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message));

client.login(process.env.DISCORD_BOT_TOKEN);
