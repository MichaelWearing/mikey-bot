const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const API_URL = "https://www.warcraftlogs.com/api/v2/client";

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const clientId = process.env.WCL_CLIENT_ID;
  const clientSecret = process.env.WCL_CLIENT_SECRET;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    throw new Error(`WCL token request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

export async function wclQuery(query, variables = {}) {
  const token = await getToken();

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    // WCL's own outages (502/504/429) come back as a full Cloudflare HTML error
    // page, sometimes thousands of characters — stuffing that whole thing into the
    // Error message meant every command's catch block, which just does
    // `interaction.editReply("Couldn't analyze that report: " + err.message)`,
    // blew past Discord's 2000-char message limit and failed to even report the
    // error (DiscordAPIError[50035] "Invalid Form Body"), showing the user a blank
    // "Something went wrong" instead of the real problem. Truncate here so every
    // caller downstream is safe without having to remember to do it themselves.
    const body = (await res.text()).slice(0, 300);
    throw new Error(`WCL API request failed: ${res.status} ${body}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`WCL API returned errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}
