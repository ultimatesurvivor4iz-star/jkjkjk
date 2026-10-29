const { SlashCommandBuilder } = require("discord.js");

const commands = [
new SlashCommandBuilder()
  .setName("servers")
  .setDescription("List available DayZ servers"),
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Check your coin balance"),

  new SlashCommandBuilder()
    .setName("shop")
    .setDescription("Browse the DayZ shop by category"),

  


new SlashCommandBuilder()
  .setName("buy")
  .setDescription("Purchase an item or teleport")
  .addSubcommand(subcommand => subcommand
    .setName("item")
    .setDescription("Purchase an item from the DayZ shop")
    .addStringOption(option => option.setName("item").setDescription("Item ID from the shop").setRequired(true).setMaxLength(40))
    .addStringOption(option => option.setName("server").setDescription("Server to purchase for").setRequired(true).setAutocomplete(true))
    .addNumberOption(option => option.setName("x").setDescription("Spawn position X coordinate").setRequired(true))
    .addNumberOption(option => option.setName("y").setDescription("Spawn position Y coordinate (height)").setRequired(true))
    .addNumberOption(option => option.setName("z").setDescription("Spawn position Z coordinate").setRequired(true))
    .addIntegerOption(option => option.setName("quantity").setDescription("Quantity to buy").setMinValue(1).setMaxValue(10))
  )
  .addSubcommand(subcommand => subcommand
    .setName("teleport")
    .setDescription("Purchase a timed teleport area")
    .addStringOption(option => option.setName("server").setDescription("Server to purchase for").setRequired(true).setAutocomplete(true))
    .addNumberOption(option => option.setName("start_x").setDescription("Teleport area start X").setRequired(true))
    .addNumberOption(option => option.setName("start_y").setDescription("Teleport area start Y").setRequired(true))
    .addNumberOption(option => option.setName("start_z").setDescription("Teleport area start Z").setRequired(true))
    .addNumberOption(option => option.setName("end_x").setDescription("Safe destination X").setRequired(true))
    .addNumberOption(option => option.setName("end_y").setDescription("Safe destination Y").setRequired(true))
    .addNumberOption(option => option.setName("end_z").setDescription("Safe destination Z").setRequired(true))
    .addIntegerOption(option => option.setName("resets").setDescription("Number of two-hour resets to purchase").setRequired(true).setMinValue(1).setMaxValue(10))
  )


].map(command => command.toJSON());

module.exports = commands;
