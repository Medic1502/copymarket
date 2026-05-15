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
    .setTitle('⚡ How Jonin CT Works')
    .setDescription('Jonin CT mirrors the trades of top Polymarket traders directly to your wallet — automatically, 24/7.')
    .addFields(
      { name: '1️⃣  Get your license', value: 'Purchase a Premium CT subscription to unlock access. Use `/getkey` in <#get-key> to receive your personal license key via DM.', inline: false },
      { name: '2️⃣  Download & activate', value: 'Download the **Jonin CT Desktop App** from <#downloads>. Open it, paste your license key and click Activate.', inline: false },
      { name: '3️⃣  Fund your wallet', value: 'A Polygon wallet is created automatically for you. Deposit **USDC** to start trading. No MetaMask or crypto experience needed.', inline: false },
      { name: '4️⃣  Choose a trader', value: 'Paste any top trader\'s wallet address from the [Polymarket leaderboard](https://polymarket.com). Set your copy settings and click **Resume** to start.', inline: false },
      { name: '5️⃣  Sit back & track', value: 'Every trade they make is mirrored to your wallet proportionally. Monitor your P&L, win rate and active positions in real time from the dashboard.', inline: false }
    )
    .addFields({
      name: '⚠️ Risk notice',
      value: 'Trading prediction markets involves risk of capital loss. Past performance of any trader does not guarantee future results. Only trade with funds you can afford to lose.',
      inline: false
    })
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
            { name: 'Rules', value: 'rules' },
            { name: 'Get key info', value: 'getkey' },
            { name: 'Welcome', value: 'welcome' },
            { name: 'All (how it works + rules + get key)', value: 'all' },
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
