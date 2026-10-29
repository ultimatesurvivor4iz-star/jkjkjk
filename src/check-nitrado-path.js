
require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env")
});

const servers = require("./config/servers.json").servers;

async function main() {
  const server = servers.find(s => s.id === "dayz-5");
  if (!server) throw new Error("Server dayz-5 not found");

  const token = process.env.NITRADO_TOKEN;
  if (!token) throw new Error("NITRADO_TOKEN is missing");

  const directories = [
    "/games/ni8985720_4/ftproot",
    "/games/ni8985720_4/ftproot/dayzps_missions",
    "/games/ni8985720_4/ftproot/dayzps",
    "/games/ni8985720_4/ftproot/dayzps/config",
	"/games/ni8985720_4/ftproot/dayzps_missions/dayzOffline.chernarusplus"
  ];

  for (const directory of directories) {
    console.log(`\n--- Listing: ${directory} ---`);

    const url = new URL(
      `https://api.nitrado.net/services/${server.serviceId}/gameservers/file_server/list`
    );
    url.searchParams.set("dir", directory);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(20000)
    });

    const text = await response.text();

    console.log("HTTP:", response.status);

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      console.log(text);
      continue;
    }

    if (!response.ok) {
      console.log(body.message || body.error || text);
      continue;
    }

    console.log(JSON.stringify(body.data ?? body, null, 2));
  }
}

main().catch(error => {
  console.error("[nitrado-path-check]", error.message);
  process.exitCode = 1;
});
