require("dotenv").config({
  path: require("node:path").resolve(__dirname, "..", ".env")
});

const { listServers, getServer } = require("./server-registry");
const {
  startAdmFeedWatcher,
  findPlayerById,
  findPlayersByName
} = require("./adm-feed");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags
} = require("discord.js");

const {
  ensurePlayer,
  getPlayer,
  purchase,
  grantCoins,
  transferCoins,
  economyAction,
  limitedEconomyAction,
  robPlayer,
  depositCoins,
  withdrawCoins,
  getDayzLink,
  saveDayzLink,
  forceSaveDayzLink,
  forceDeleteDayzLink,
  selfDeleteDayzLink
} = require("./db");

const shop = require("./shop.json");
const { buyTeleport, startTeleportScheduler } = require("./teleport-shop");
const fs = require("node:fs");
const path = require("node:path");

const BRAND_LOGO_PATH = path.resolve(
  __dirname,
  "..",
  "ultimatesurvivor2.png"
);
const BRAND_LOGO_FILENAME = "ultimatesurvivor2.png";
const BRAND_FOOTER = "UltimateSurvivorDAYZ, making memories";

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const SHOP_PAGE_SIZE = 10;

// Discover every category present in shop.json.
function getShopCategories() {
  return [
    ...new Set(
      shop.map(item => (item.category || "other").toLowerCase())
    )
  ].sort();
}

// Build the category dropdown and paginated shop embed.
function buildShopPage(category, page, userId) {
  const categories = getShopCategories();

  const categoryItems = shop.filter(
    item => (item.category || "other").toLowerCase() === category
  );

  const totalPages = Math.max(
    1,
    Math.ceil(categoryItems.length / SHOP_PAGE_SIZE)
  );

  page = Math.max(0, Math.min(page, totalPages - 1));

  const pageItems = categoryItems.slice(
    page * SHOP_PAGE_SIZE,
    (page + 1) * SHOP_PAGE_SIZE
  );

  const description = pageItems.length
    ? pageItems.map(item =>
        `**${item.name}** — $${item.price} DayZ Dollars\n` +
        `Item ID: \`${item.id}\``
      ).join("\n\n")
    : "No items are available in this category.";

  const titleCategory =
    category.charAt(0).toUpperCase() + category.slice(1);

  const embed = new EmbedBuilder()
    .setTitle(`DayZ Shop — ${titleCategory}`)
    .setColor(0xD4A017)
    .setDescription(description)
    .setFooter({
      text:
        `${BRAND_FOOTER} • Page ${page + 1}/${totalPages} • ` +
        `${categoryItems.length} items`
    });

  // The attachment thumbnail appears at the top-right of the embed.
  const responseFiles = fs.existsSync(BRAND_LOGO_PATH)
    ? [{
        attachment: BRAND_LOGO_PATH,
        name: BRAND_LOGO_FILENAME
      }]
    : [];

  if (responseFiles.length) {
    embed.setThumbnail(`attachment://${BRAND_LOGO_FILENAME}`);
  } else {
    console.warn(`[branding] Logo not found: ${BRAND_LOGO_PATH}`);
  }

  // Discord allows a maximum of 25 options in one select menu.
  const visibleCategories = categories.slice(0, 25);

  const categoryMenu = new StringSelectMenuBuilder()
    .setCustomId(`shopcat:${userId}`)
    .setPlaceholder("Choose a category")
    .addOptions(
      visibleCategories.map(cat => ({
        label: cat.charAt(0).toUpperCase() + cat.slice(1),
        value: cat,
        default: cat === category
      }))
    );

  const categoryRow = new ActionRowBuilder()
    .addComponents(categoryMenu);

  const previousButton = new ButtonBuilder()
    .setCustomId(`shoppage:prev:${userId}`)
    .setLabel("Previous")
    .setEmoji("◀️")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page === 0);

  const nextButton = new ButtonBuilder()
    .setCustomId(`shoppage:next:${userId}`)
    .setLabel("Next")
    .setEmoji("▶️")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page >= totalPages - 1);

  const navigationRow = new ActionRowBuilder()
    .addComponents(previousButton, nextButton);

  return {
    embeds: [embed],
    components: [categoryRow, navigationRow],
    ...(responseFiles.length ? { files: responseFiles } : {})
  };
}

// Slash commands.
const commands = [
  new SlashCommandBuilder()
    .setName("servers")
    .setDescription("List available DayZ servers"),

  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Check your cash and bank balance"),

  ...[
    ["work", "Work a shift to earn $100–$250 (10 uses per 2 hours)"],
    ["slut", "Earn $50–$1,000 (10 uses per 2 hours)"],
    ["crime", "Earn $80–$1,000 (10 uses per 2 hours)"],
  ].map(([name, description]) => new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)),

  new SlashCommandBuilder()
    .setName("rob")
    .setDescription("Rob 1–5% of another player's cash (5 uses per 2 hours)")
    .addUserOption(o =>
      o.setName("target")
        .setDescription("Player to rob")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("deposit")
    .setDescription("Move cash into your bank")
    .addIntegerOption(o =>
      o.setName("amount")
        .setDescription("Whole number of coins")
        .setMinValue(1)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("withdraw")
    .setDescription("Move bank balance into cash")
    .addIntegerOption(o =>
      o.setName("amount")
        .setDescription("Whole number of coins")
        .setMinValue(1)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("pay")
    .setDescription("Pay cash coins to another member")
    .addUserOption(option =>
      option
        .setName("member")
        .setDescription("Member to pay")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("amount")
        .setDescription("Whole number of coins to pay")
        .setMinValue(1)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Admin economy tools")
    .addSubcommand(subcommand =>
      subcommand
        .setName("money")
        .setDescription("Admin: add newly created cash coins to a member")
        .addUserOption(option =>
          option
            .setName("member")
            .setDescription("Member receiving the coins")
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName("amount")
            .setDescription("Whole number of coins to add")
            .setMinValue(1)
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName("username")
    .setDescription("Manage your Discord-to-DayZ character link")
    .addSubcommand(sc =>
      sc
        .setName("link")
        .setDescription(
          "Automatically link your Discord account to a DayZ character"
        )
        .addStringOption(o =>
          o
            .setName("player_name")
            .setDescription(
              "Your exact in-game DayZ name as shown in the ADM log"
            )
            .setRequired(true)
            .setMaxLength(64)
        )
    )
    .addSubcommand(sc =>
      sc
        .setName("status")
        .setDescription("Check your DayZ link status")
    )
    .addSubcommand(sc =>
      sc
        .setName("unlink")
        .setDescription("Remove your own DayZ link")
    )
    .addSubcommand(sc =>
      sc
        .setName("force-link")
        .setDescription("Admin: link a member to a DayZ character")
        .addUserOption(o =>
          o
            .setName("member")
            .setDescription("Discord member to link")
            .setRequired(true)
        )
        .addStringOption(o =>
          o
            .setName("gamertag")
            .setDescription("Exact in-game gamertag")
            .setRequired(true)
            .setMaxLength(64)
        )
        .addStringOption(o =>
          o
            .setName("player_id")
            .setDescription(
              "Stable player ID from the ADM log, if the name is ambiguous"
            )
            .setRequired(false)
            .setMaxLength(100)
        )
        .addBooleanOption(o =>
          o
            .setName("replace_existing")
            .setDescription(
              "Explicitly replace conflicting links; use only after confirming"
            )
            .setRequired(false)
        )
    )
    .addSubcommand(sc =>
      sc
        .setName("force-unlink")
        .setDescription("Admin: remove a member's DayZ link")
        .addUserOption(o =>
          o
            .setName("member")
            .setDescription("Discord member to unlink")
            .setRequired(true)
        )
        .addStringOption(o =>
          o
            .setName("reason")
            .setDescription("Reason for the admin action")
            .setRequired(true)
            .setMaxLength(250)
        )
    ),

  new SlashCommandBuilder()
    .setName("location")
    .setDescription(
      "Show a linked DayZ character's latest logged location"
    )
    .addStringOption(o =>
      o
        .setName("server")
        .setDescription("Server to check")
        .setRequired(true)
        .addChoices({
          name: "dayz-5 (+99LOOT)",
          value: "dayz-5"
        })
    )
    .addUserOption(o =>
      o
        .setName("player")
        .setDescription("Admin only: another Discord member to locate")
    ),

  new SlashCommandBuilder()
    .setName("locate")
    .setDescription(
      "Alias for /location; admins may select another member"
    )
    .addStringOption(o =>
      o
        .setName("server")
        .setDescription("Server to check")
        .setRequired(true)
        .addChoices({
          name: "dayz-5 (+99LOOT)",
          value: "dayz-5"
        })
    )
    .addUserOption(o =>
      o
        .setName("player")
        .setDescription("Admin only: another Discord member to locate")
    ),

  new SlashCommandBuilder()
    .setName("shop")
    .setDescription("Browse the DayZ shop by category"),

  new SlashCommandBuilder()
    .setName("buy")
    .setDescription("Buy shop items or a teleport area")
    .addSubcommand(sc => sc
      .setName("item")
      .setDescription("Purchase an item from the DayZ shop")
      .addStringOption(o =>
        o.setName("item")
          .setDescription("Item ID from /shop")
          .setRequired(true)
          .setMaxLength(40)
      )
      .addStringOption(o =>
        o.setName("server")
          .setDescription("Server to purchase for")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addNumberOption(o =>
        o.setName("x")
          .setDescription("Spawn position X coordinate")
          .setRequired(true)
      )
      .addNumberOption(o =>
        o.setName("y")
          .setDescription("Spawn position Y coordinate (height)")
          .setRequired(true)
      )
      .addNumberOption(o =>
        o.setName("z")
          .setDescription("Spawn position Z coordinate")
          .setRequired(true)
      )
      // Required options must be placed before optional options.
      .addStringOption(o =>
        o.setName("payment")
          .setDescription("Pay from cash or bank")
          .setRequired(true)
          .addChoices(
            { name: "Cash", value: "cash" },
            { name: "Bank balance", value: "bank" }
          )
      )
      .addIntegerOption(o =>
        o.setName("quantity")
          .setDescription("Quantity to buy")
          .setMinValue(1)
          .setMaxValue(10)
          .setRequired(false)
      )
    )
    .addSubcommand(sc => sc
      .setName("teleport")
      .setDescription("Buy a temporary DayZ teleport area")
      .addStringOption(o =>
        o.setName("server")
          .setDescription("Server to create the teleport on")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addNumberOption(o =>
        o.setName("start_x")
          .setDescription("Teleport trigger X")
          .setRequired(true)
      )
      .addNumberOption(o =>
        o.setName("start_y")
          .setDescription("Teleport trigger Y")
          .setRequired(true)
      )
      .addNumberOption(o =>
        o.setName("start_z")
          .setDescription("Teleport trigger Z")
          .setRequired(true)
      )
      .addNumberOption(o =>
        o.setName("end_x")
          .setDescription("Teleport destination X")
          .setRequired(true)
      )
      .addNumberOption(o =>
        o.setName("end_y")
          .setDescription("Teleport destination Y")
          .setRequired(true)
      )
      .addNumberOption(o =>
        o.setName("end_z")
          .setDescription("Teleport destination Z")
          .setRequired(true)
      )
      .addIntegerOption(o =>
        o.setName("resets")
          .setDescription("Number of two-hour resets (1–10)")
          .setMinValue(1)
          .setMaxValue(10)
          .setRequired(true)
      )
    )
].map(command => command.toJSON());

function hasConfiguredAdminRole(interaction) {
  const roleId = process.env.ADM_ADMIN_ROLE_ID;

  if (!roleId || !interaction.inGuild()) {
    return false;
  }

  const roles = interaction.member?.roles;

  if (roles?.cache?.has) {
    return roles.cache.has(roleId);
  }

  return Array.isArray(roles) && roles.includes(roleId);
}

function getPlayerAccount(id) {
  ensurePlayer.run(
    id,
    Number(process.env.STARTING_COINS || 100)
  );

  return getPlayer.get(id);
}

// Register guild slash commands every time the bot starts.
// Use "ready" for compatibility across discord.js v14 minor versions.
client.once("ready", async () => {
  console.log(`Bot online as ${client.user.tag}`);

  startAdmFeedWatcher(client, listServers);
  try {
    startTeleportScheduler(getServer);
  } catch (error) {
    console.error("Teleport scheduler could not start:", error.message || error);
  }

  const applicationId = process.env.DISCORD_CLIENT_ID?.trim();
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  const token = process.env.DISCORD_TOKEN?.trim();

  if (!applicationId || !guildId || !token) {
    console.error(
      "Slash command registration skipped: DISCORD_CLIENT_ID, " +
      "DISCORD_GUILD_ID, and DISCORD_TOKEN must all be set in .env."
    );
    return;
  }

  try {
    const rest = new REST({ version: "10" }).setToken(token);
    const route = Routes.applicationGuildCommands(applicationId, guildId);

    console.log(
      `Registering ${commands.length} guild slash commands to guild ${guildId}: ` +
      commands.map(command => command.name).join(", ")
    );

    await rest.put(route, { body: commands });

    console.log(
      `Successfully registered ${commands.length} guild slash commands to guild ${guildId}.`
    );
  } catch (error) {
    console.error("Slash command registration failed:", error);
    if (error?.rawError) {
      console.error("Discord API response:", JSON.stringify(error.rawError, null, 2));
    }
  }
});

client.on("interactionCreate", async interaction => {
  try {
    // Category dropdown selection.
    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith("shopcat:")
    ) {
      const ownerId = interaction.customId.split(":")[1];

      if (interaction.user.id !== ownerId) {
        return interaction.reply({
          content: "Run /shop to open your own shop menu.",
          flags: MessageFlags.Ephemeral
        });
      }

      const category = interaction.values[0];

      return interaction.update(
        buildShopPage(category, 0, ownerId)
      );
    }

    // Previous / Next pagination.
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("shoppage:")
    ) {
      const [, direction, ownerId] =
        interaction.customId.split(":");

      if (interaction.user.id !== ownerId) {
        return interaction.reply({
          content: "Run /shop to open your own shop menu.",
          flags: MessageFlags.Ephemeral
        });
      }

      const footer =
        interaction.message.embeds[0]?.footer?.text || "";

      const pageMatch = footer.match(/Page (\d+)\/(\d+)/);
      const currentPage = pageMatch
        ? Number(pageMatch[1]) - 1
        : 0;

      const title = interaction.message.embeds[0]?.title || "";
      const category = title
        .replace(/^DayZ Shop — /, "")
        .toLowerCase();

      const nextPage =
        currentPage + (direction === "next" ? 1 : -1);

      return interaction.update(
        buildShopPage(category, nextPage, ownerId)
      );
    }

    // Server autocomplete for /buy.
    if (interaction.isAutocomplete()) {
      if (
        interaction.commandName === "buy" &&
        interaction.options.getFocused(true).name === "server"
      ) {
        const focused = String(
          interaction.options.getFocused()
        ).toLowerCase();

        const choices = listServers()
          .filter(server =>
            server.configured &&
            (
              server.id.toLowerCase().includes(focused) ||
              server.name.toLowerCase().includes(focused)
            )
          )
          .slice(0, 25)
          .map(server => ({
            name: `${server.name} (${server.id})`.slice(0, 100),
            value: server.id
          }));

        return interaction.respond(choices);
      }

      return interaction.respond([]);
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    const userId = interaction.user.id;

    // Username linking commands.
    if (interaction.commandName === "username") {
      const sub = interaction.options.getSubcommand();
      const serverId = "dayz-5";

      if (sub === "link") {
        const playerName = interaction.options
          .getString("player_name", true)
          .trim();

        if (!playerName) {
          return interaction.reply({
            content: "Enter your exact in-game DayZ name.",
            flags: MessageFlags.Ephemeral
          });
        }

        const matches = findPlayersByName(serverId, playerName);

        if (!matches.length) {
          return interaction.reply({
            content:
              `I couldn't find a position record for **${playerName}** ` +
              `on **${serverId}** yet. Join the server and wait for the ` +
              "ADM log to record your position, then try again.",
            flags: MessageFlags.Ephemeral
          });
        }

        const distinctIds = [
          ...new Map(matches.map(p => [p.playerId, p])).values()
        ];

        if (distinctIds.length > 1) {
          return interaction.reply({
            content:
              `More than one DayZ player ID has used the name **${playerName}**. ` +
              "To avoid linking the wrong character, ask an admin to use " +
              "/username force-link with the correct stable player ID.",
            flags: MessageFlags.Ephemeral
          });
        }

        const observed = distinctIds[0];
        const current = getDayzLink.get(userId);

        if (
          current?.status === "verified" &&
          current.player_id === observed.playerId &&
          current.server_id === serverId
        ) {
          return interaction.reply({
            content:
              `You're already linked to **${observed.playerName}** ` +
              `on **${serverId}**.`,
            flags: MessageFlags.Ephemeral
          });
        }

        try {
          saveDayzLink({
            discordId: userId,
            playerName: observed.playerName,
            playerId: observed.playerId,
            serverId,
            actorDiscordId: userId
          });
        } catch (error) {
          return interaction.reply({
            content: error.message,
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.reply({
          content:
            `✅ Automatically linked your Discord account to ` +
            `**${observed.playerName}** on **${serverId}**. ` +
            `Use /location server:${serverId} to see your latest recorded position.`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (sub === "status") {
        const link = getDayzLink.get(userId);

        return interaction.reply({
          content: !link
            ? "Your Discord account is not linked. Use `/username link`."
            : link.status === "verified" && link.player_id
              ? `Linked character: **${link.player_name}** on ` +
                `**${link.server_id || serverId}** ` +
                `(DayZ ID: ${link.player_id}).`
              : `Your link for **${link.player_name}** is incomplete. ` +
                "Try /username link again or ask an admin for help.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (sub === "unlink") {
        const removed = selfDeleteDayzLink({
          discordId: userId
        });

        return interaction.reply({
          content: removed
            ? `Your link to **${removed.player_name}** has been removed.`
            : "Your Discord account did not have a DayZ link.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (sub === "force-link") {
        if (!hasConfiguredAdminRole(interaction)) {
          return interaction.reply({
            content:
              "You need the configured DayZ admin role to force-link a member.",
            flags: MessageFlags.Ephemeral
          });
        }

        const member = interaction.options.getUser("member", true);
        const gamertag = interaction.options
          .getString("gamertag", true)
          .trim();

        const requestedPlayerId = interaction.options
          .getString("player_id")
          ?.trim();

        const replaceExisting =
          interaction.options.getBoolean("replace_existing") ?? false;

        let observed;

        if (requestedPlayerId) {
          observed = findPlayerById(serverId, requestedPlayerId);

          if (!observed) {
            return interaction.reply({
              content:
                `Player ID ${requestedPlayerId} has no recorded position ` +
                "in the monitored ADM log.",
              flags: MessageFlags.Ephemeral
            });
          }

          if (
            observed.playerName.toLocaleLowerCase() !==
            gamertag.toLocaleLowerCase()
          ) {
            return interaction.reply({
              content:
                `That ID belongs to **${observed.playerName}**, ` +
                `not **${gamertag}**. No link was changed.`,
              flags: MessageFlags.Ephemeral
            });
          }
        } else {
          const matches = [
            ...new Map(
              findPlayersByName(serverId, gamertag)
                .map(p => [p.playerId, p])
            ).values()
          ];

          if (!matches.length) {
            return interaction.reply({
              content:
                `I couldn't find **${gamertag}** with a recorded position ` +
                `on **${serverId}**.`,
              flags: MessageFlags.Ephemeral
            });
          }

          if (matches.length > 1) {
            return interaction.reply({
              content:
                `**${gamertag}** matches multiple stable player IDs. ` +
                "Re-run /username force-link and provide the exact player_id " +
                "from the ADM log.",
              flags: MessageFlags.Ephemeral
            });
          }

          observed = matches[0];
        }

        try {
          forceSaveDayzLink({
            actorDiscordId: userId,
            discordId: member.id,
            playerName: observed.playerName,
            playerId: observed.playerId,
            serverId,
            replaceExisting
          });
        } catch (error) {
          return interaction.reply({
            content: error.message,
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.reply({
          content:
            `✅ Linked ${member} to **${observed.playerName}** on ` +
            `**${serverId}** (DayZ ID: ${observed.playerId}). ` +
            "Admin action recorded.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (sub === "force-unlink") {
        if (!hasConfiguredAdminRole(interaction)) {
          return interaction.reply({
            content:
              "You need the configured DayZ admin role to force-unlink a member.",
            flags: MessageFlags.Ephemeral
          });
        }

        const member = interaction.options.getUser("member", true);
        const reason = interaction.options
          .getString("reason", true)
          .trim();

        const removed = forceDeleteDayzLink({
          actorDiscordId: userId,
          discordId: member.id,
          reason
        });

        return interaction.reply({
          content: removed
            ? `✅ Removed ${member}'s link to **${removed.player_name}**. ` +
              `Reason: ${reason}`
            : `${member} did not have a DayZ link.`,
          flags: MessageFlags.Ephemeral
        });
      }
    }

    // Character location commands.
    if (
      interaction.commandName === "location" ||
      interaction.commandName === "locate"
    ) {
      const serverId = interaction.options.getString("server", true);
      const target =
        interaction.options.getUser("player") || interaction.user;

      const isAdmin = hasConfiguredAdminRole(interaction);

      if (target.id !== userId && !isAdmin) {
        return interaction.reply({
          content:
            "You can only look up your own linked character. " +
            "Only configured DayZ admins may locate other members.",
          flags: MessageFlags.Ephemeral
        });
      }

      const link = getDayzLink.get(target.id);

      if (
        !link ||
        link.status !== "verified" ||
        !link.player_id
      ) {
        return interaction.reply({
          content: target.id === userId
            ? "Your DayZ identity is not linked yet. Use `/username link` after your character has a recorded position."
            : "That member does not have a linked DayZ character.",
          flags: MessageFlags.Ephemeral
        });
      }

      if ((link.server_id || "dayz-5") !== serverId) {
        return interaction.reply({
          content:
            `That member's link is for **${link.server_id || "dayz-5"}**, ` +
            `not **${serverId}**.`,
          flags: MessageFlags.Ephemeral
        });
      }

      const location = findPlayerById(serverId, link.player_id);

      if (!location) {
        return interaction.reply({
          content:
            "No position for that character has been recorded in the monitored ADM log yet.",
          flags: MessageFlags.Ephemeral
        });
      }

      return interaction.reply({
        content:
          `📍 **${location.playerName}** on **${serverId}**\n` +
          `X: \`${location.x}\` · Y: \`${location.y}\` · Z: \`${location.z}\`\n` +
          `Recorded: \`${location.time || "time unavailable"}\`\n\n` +
          "This is the latest position recorded in the ADM log, not a live GPS fix.",
        flags: MessageFlags.Ephemeral
      });
    }

    // Balance: cash, bank, and combined total.
    if (interaction.commandName === "balance") {
      const player = getPlayerAccount(userId);
      const cash = Number(player.coins || 0);
      const bank = Number(player.bank || 0);

      return interaction.reply({
        content:
          `🪙 **Your DayZ Dollars**\n` +
          `Cash: **$${cash}**\n` +
          `Bank: **$${bank}**\n` +
          `Total: **$${cash + bank}**`,
        flags: MessageFlags.Ephemeral
      });
    }

    // Pay another member from cash.
    if (interaction.commandName === "pay") {
      const recipient = interaction.options.getUser("member", true);
      const amount = interaction.options.getInteger("amount", true);

      if (recipient.bot) {
        return interaction.reply({
          content: "You cannot pay a bot.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (recipient.id === userId) {
        return interaction.reply({
          content: "You cannot pay yourself.",
          flags: MessageFlags.Ephemeral
        });
      }

      const sender = getPlayerAccount(userId);

      if (sender.coins < amount) {
        return interaction.reply({
          content:
            `You only have **$${sender.coins} cash**. ` +
            `You cannot pay $${amount}.`,
          flags: MessageFlags.Ephemeral
        });
      }

      try {
        transferCoins(userId, recipient.id, amount);
      } catch (error) {
        return interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral
        });
      }

      // Public confirmation lets the recipient see that they were paid.
      return interaction.reply({
        content:
          `✅ ${interaction.user} paid ${recipient} ` +
          `**$${amount}** in DayZ Dollars.`
      });
    }

    // Admin-only money creation.
    // Usage: /add money member:<member> amount:<amount>
    if (interaction.commandName === "add") {
      if (interaction.options.getSubcommand() !== "money") {
        return;
      }

      if (!hasConfiguredAdminRole(interaction)) {
        return interaction.reply({
          content:
            "You need the configured DayZ admin role to add money.",
          flags: MessageFlags.Ephemeral
        });
      }

      const recipient = interaction.options.getUser("member", true);
      const amount = interaction.options.getInteger("amount", true);

      if (recipient.bot) {
        return interaction.reply({
          content: "You cannot add money to a bot account.",
          flags: MessageFlags.Ephemeral
        });
      }

      try {
        grantCoins(
          recipient.id,
          amount,
          `Admin grant by ${userId}`
        );
      } catch (error) {
        return interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral
        });
      }

      return interaction.reply({
        content:
          `✅ Added **$${amount}** DayZ Dollars to ` +
          `${recipient}'s cash balance.`,
        flags: MessageFlags.Ephemeral
      });
    }

    // List servers.
    if (interaction.commandName === "servers") {
      const servers = listServers({ includeDisabled: true });

      const description = servers.map(server => {
        const state = !server.enabled
          ? "Disabled"
          : server.configured
            ? "Configured"
            : "Needs Nitrado service ID";

        const delivery = server.itemDeliveryEnabled
          ? "Delivery flag enabled; verification still required"
          : "Delivery disabled";

        return (
          `**${server.name}** (\`${server.id}\`)\n` +
          `Status: ${state}\n${delivery}`
        );
      }).join("\n\n");

      return interaction.reply({
        content: description || "No servers are configured.",
        flags: MessageFlags.Ephemeral
      });
    }

    // Browse the shop.
    if (interaction.commandName === "shop") {
      const categories = getShopCategories();

      if (categories.length === 0) {
        return interaction.reply({
          content: "The shop catalogue is empty.",
          flags: MessageFlags.Ephemeral
        });
      }

      return interaction.reply(
        buildShopPage(categories[0], 0, userId)
      );
    }

    // Economy actions use rolling two-hour quotas.
    if (["work", "slut", "crime"].includes(interaction.commandName)) {
      const rewards = {
        work: [100, 250],
        slut: [50, 1000],
        crime: [80, 1000]
      };

      const [min, max] = rewards[interaction.commandName];

      try {
        const result = limitedEconomyAction(
          userId,
          interaction.commandName,
          min,
          max,
          10,
          2 * 60 * 60 * 1000
        );

        return interaction.reply({
          content:
            `✅ You completed /${interaction.commandName} and earned ` +
            `**$${result.amount}**. Uses: **${result.used}/${result.limit}** ` +
            `in the last 2 hours. Cash balance: **$${result.player.coins}**.`,
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        return interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral
        });
      }
    }

    if (interaction.commandName === "rob") {
      const target = interaction.options.getUser("target", true);

      if (target.bot) {
        return interaction.reply({
          content: "You cannot rob a bot account.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (target.id === userId) {
        return interaction.reply({
          content: "You cannot rob yourself.",
          flags: MessageFlags.Ephemeral
        });
      }

      try {
        const result = robPlayer(userId, target.id);

        return interaction.reply({
          content:
            `💰 You robbed **$${result.amount}** (${result.percent}%) from ` +
            `${target}. Uses: **${result.used}/${result.limit}** in the last ` +
            `2 hours. Your cash: **$${result.player.coins}**. ` +
            `Target cash remaining: **$${result.target.coins}**.`,
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        return interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral
        });
      }
    }

    if (
      interaction.commandName === "deposit" ||
      interaction.commandName === "withdraw"
    ) {
      const amount = interaction.options.getInteger("amount", true);

      try {
        const player = interaction.commandName === "deposit"
          ? depositCoins(userId, amount)
          : withdrawCoins(userId, amount);

        return interaction.reply({
          content:
            `✅ ${interaction.commandName === "deposit" ? "Deposited" : "Withdrew"} ` +
            `**$${amount}**. Cash: **$${player.coins}** · Bank: **$${player.bank}**.`,
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        return interaction.reply({
          content: error.message,
          flags: MessageFlags.Ephemeral
        });
      }
    }

    // /buy item and /buy teleport are distinct subcommands.
    if (interaction.commandName === "buy") {
      const subcommand = interaction.options.getSubcommand();

      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      const serverId = interaction.options.getString("server", true);
      const server = getServer(serverId);

      if (subcommand === "teleport") {
        const startCoords = [
          "start_x",
          "start_y",
          "start_z"
        ].map(name => interaction.options.getNumber(name, true));

        const endCoords = [
          "end_x",
          "end_y",
          "end_z"
        ].map(name => interaction.options.getNumber(name, true));

        const resets = interaction.options.getInteger("resets", true);

        const result = await buyTeleport({
          discordId: userId,
          server,
          start: startCoords,
          end: endCoords,
          resets
        });

        return interaction.editReply(
          `✅ Teleport area **${result.areaName}** created for **${server.name}**.\n` +
          `Start: \`${startCoords.join(", ")}\`\n` +
          `Destination: \`${endCoords.join(", ")}\`\n` +
          `Resets: **${resets}**\n` +
          `Cost: **$${result.total}** cash. The area will be activated by the managed restart cycle.`
        );
      }

      const itemId = interaction.options
        .getString("item", true)
        .toLowerCase();

      const quantity = interaction.options.getInteger("quantity") || 1;

      const item = shop.find(
        entry => entry.id.toLowerCase() === itemId
      );

      if (!item) {
        return interaction.editReply(
          "Item not found. Check its ID using /shop."
        );
      }

      if (!server.configured) {
        return interaction.editReply(
          "That server is not configured for purchases."
        );
      }

      const paymentSource = interaction.options.getString(
        "payment",
        true
      );

      const order = purchase(
        userId,
        item,
        quantity,
        server.id,
        paymentSource
      );

      return interaction.editReply(
        `✅ Order **#${order.id}** created!\n` +
        `Server: **${server.name}**\n` +
        `Item: **${item.name}**\n` +
        `Quantity: ${quantity}\n` +
        `Cost: **$${order.total}** paid from **${paymentSource === "bank" ? "Bank balance" : "Cash"}**\n` +
        `Delivery: **Pending — not spawned in-game yet.**`
      );
    }

  } catch (error) {
    console.error("Interaction error:", error);

    const message = {
      content: `❌ Something went wrong: ${error.message}`,
      flags: MessageFlags.Ephemeral
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(message).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.reply(message).catch(() => {});
    }
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in your .env file.");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);