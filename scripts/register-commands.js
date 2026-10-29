
require("dotenv").config({
  path: require("node:path").resolve(__dirname, "..", ".env")
});

const { REST, Routes } = require("discord.js");
const commands = require("../src/commands");

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID
} = process.env;

async function registerCommands() {
  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
    console.error(
      "Missing DISCORD_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID in .env"
    );
    process.exitCode = 1;
    return;
  }

  const rest = new REST({ version: "10" })
    .setToken(DISCORD_TOKEN);

  try {
    console.log(`Registering ${commands.length} Discord commands...`);

    const registered = await rest.put(
      Routes.applicationGuildCommands(
        DISCORD_CLIENT_ID,
        DISCORD_GUILD_ID
      ),
      { body: commands }
    );

    console.log(
      `Successfully registered ${registered.length} Discord commands.`
    );
  } catch (error) {
    console.error("Failed to register Discord commands:", error.message);
    process.exitCode = 1;
  }
}

registerCommands();
