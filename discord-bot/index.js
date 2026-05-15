require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const fetch = require('node-fetch');

const RAILWAY_URL = process.env.RAILWAY_API_URL;
const BOT_SECRET  = process.env.DISCORD_BOT_SECRET;
const PREMIUM_ROLE = 'Premium CT';

if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_CLIENT_ID || !RAILWAY_URL || !BOT_SECRET) {
  console.error('Missing required env vars: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, RAILWAY_API_URL, DISCORD_BOT_SECRET');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('getkey')
      .setDescription('Get your Jonin CT license key (requires Premium CT role)')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('revokekey')
      .setDescription('[Admin] Revoke a user license key')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(opt =>
        opt.setName('key').setDescription('The license key UUID to revoke').setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('resetmachine')
      .setDescription('[Admin] Reset HWID so user can activate on a new machine')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(opt =>
        opt.setName('key').setDescription('The license key UUID').setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('shufflekey')
      .setDescription('Generate a new license key (invalidates your old one, 24h cooldown)')
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
  console.log('Slash commands registered globally.');
}

client.once('clientReady', async () => {
  console.log(`Jonin CT Bot online as ${client.user.tag}`);
  await registerCommands();
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
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_SECRET}`,
        },
        body: JSON.stringify({
          discordUserId: interaction.user.id,
          discordUsername: interaction.user.username,
        }),
      });

      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      const data = await resp.json();

      const dmLines = data.existing
        ? [
            `🔑 **Your Jonin CT license key:**`,
            `\`\`\``,
            data.key,
            `\`\`\``,
            `This is your existing key. If you changed your PC, ask an admin to reset your machine binding.`,
          ]
        : [
            `🎉 **Welcome to Jonin CT Premium!**`,
            ``,
            `Your license key:`,
            `\`\`\``,
            data.key,
            `\`\`\``,
            `**How to activate:**`,
            `1. Download the Jonin CT app (check #downloads in the server)`,
            `2. Open the app`,
            `3. Paste your key and click **Activate**`,
            ``,
            `⚠️ Keep this key private. It locks to your machine on first use.`,
          ];

      try {
        await interaction.user.send(dmLines.join('\n'));
        await interaction.editReply({ content: '✅ Your license key has been sent to your DMs!' });
      } catch {
        // User has DMs closed — show key in ephemeral reply
        await interaction.editReply({
          content: [
            `✅ License key (enable DMs to receive it privately next time):`,
            `\`\`\``,
            data.key,
            `\`\`\``,
            `*Paste this in the Jonin CT app to activate.*`,
          ].join('\n'),
        });
      }
    } catch (err) {
      console.error('/getkey error:', err);
      await interaction.editReply({ content: '❌ Failed to generate key. Please try again or contact support.' });
    }
    return;
  }

  // ── /revokekey ───────────────────────────────────────────────────────────
  if (interaction.commandName === 'revokekey') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const key = interaction.options.getString('key');

    try {
      const resp = await fetch(`${RAILWAY_URL}/api/license/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_SECRET}`,
        },
        body: JSON.stringify({ key }),
      });

      if (!resp.ok) throw new Error(`Server ${resp.status}`);
      await interaction.editReply({ content: `✅ License key \`${key}\` has been revoked.` });
    } catch (err) {
      console.error('/revokekey error:', err);
      await interaction.editReply({ content: '❌ Failed to revoke key.' });
    }
    return;
  }

  // ── /shufflekey ───────────────────────────────────────────────────────────
  if (interaction.commandName === 'shufflekey') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const hasPremiumRole = interaction.member.roles.cache.some(r => r.name === PREMIUM_ROLE);
    if (!hasPremiumRole) {
      return interaction.editReply({ content: '❌ You need the **Premium CT** role to use this command.' });
    }

    try {
      const resp = await fetch(`${RAILWAY_URL}/api/license/shuffle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_SECRET}`,
        },
        body: JSON.stringify({ discordUserId: interaction.user.id }),
      });

      const data = await resp.json();

      if (data.cooldown) {
        return interaction.editReply({ content: `⏳ ${data.error}` });
      }
      if (!resp.ok || data.error) {
        return interaction.editReply({ content: `❌ ${data.error || 'Failed to shuffle key.'}` });
      }

      const dmLines = [
        `🔄 **Your old key has been invalidated.**`,
        ``,
        `Your new license key:`,
        `\`\`\``,
        data.key,
        `\`\`\``,
        `Open the Jonin CT app → the app will ask you to enter a new key.`,
        ``,
        `⚠️ Keep this key private.`,
      ];

      try {
        await interaction.user.send(dmLines.join('\n'));
        await interaction.editReply({ content: '✅ New key sent to your DMs! Deactivate the app on your old device before activating the new key.' });
      } catch {
        await interaction.editReply({
          content: [`✅ New key (enable DMs next time):`, `\`\`\``, data.key, `\`\`\``].join('\n'),
        });
      }
    } catch (err) {
      console.error('/shufflekey error:', err);
      await interaction.editReply({ content: '❌ Failed. Please try again.' });
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
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BOT_SECRET}`,
        },
        body: JSON.stringify({ key }),
      });

      if (!resp.ok) throw new Error(`Server ${resp.status}`);
      await interaction.editReply({
        content: `✅ Machine reset for key \`${key}\`. The user can now activate on a new machine.`,
      });
    } catch (err) {
      console.error('/resetmachine error:', err);
      await interaction.editReply({ content: '❌ Failed to reset machine.' });
    }
    return;
  }
});

client.on('error', (err) => console.error('Discord client error:', err.message));

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err.message));

client.login(process.env.DISCORD_BOT_TOKEN);
