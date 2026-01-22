/**
 * auth-gateway
 * 
 * Environment Variables:
 * - JWT_SECRET (string)
 * - INTERNAL_SECRET (string)
 * - REFRESH_TOKEN_EXPIRY_SECONDS (string)
 * 
 * Endpoints:
 * - POST /refresh-token (Azure only)
 * - POST /access-token (frontend)
 * - POST /logout (frontend)
 */

import { generateJWT, verifyJWT } from "./jwt.js";

const FRONTEND_ORIGIN = "https://www.packsyncr.com";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    // Handle preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (path === "/refresh-token" && request.method === "POST") {
        return await handleCreateRefresh(request, env);
      }
      if (path === "/access-token" && request.method === "GET") {
        return await handleCreateAccess(request, env);
      }
      if (path === "/logout" && request.method === "POST") {
        return await handleLogout(request, env);
      }
      return new Response("Not found", {
        status: 404,
        headers: CORS_HEADERS
      });
    } catch (err) {
      console.error("Unhandled error:", err);
      return new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: CORS_HEADERS
      });
    }
  }
};

/**
 * /refresh-token
 * Called by Azure auth-proxy after it verified OAuth code and retrieves user's Minecraft profile.
 * Body: { uuid: "<uuid>", username: "<username>", email: "<email>" }
 * Headers: x-internal-auth: <INTERNAL_SECRET>
 */
async function handleCreateRefresh(request, env) {
  // Only accept requests from Azure with INTERNAL_SECRET
  const provided = request.headers.get("x-internal-auth");
  if (!provided || provided !== env.INTERNAL_SECRET) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers : {
        "Content-Type": "application/json"
      }
    });
  }

  // Retrieve body information
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: "invalid_body" }), {
      status: 404,
      headers : {
        "Content-Type": "application/json"
      }
    })
  }
  const uuid = body.uuid;
  if (!uuid) {
    return new Response(JSON.stringify({ error: "missing_uuid" }), {
      status: 400,
      headers : {
        "Content-Type": "application/json"
      }
    });
  }
  const username = body.username;
  if (!username) {
    return new Response(JSON.stringify({ error: "missing_username" }), {
      status: 400,
      headers : {
        "Content-Type": "application/json"
      }
    });
  }
  const email = body.email;
  if (!email) {
    return new Response(JSON.stringify({ error: "missing_email" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json"
      }
    })
  }

  // Retrieve refresh token
  const { refreshToken, isNewUser } = await retrieveRefreshToken(env, uuid, username, email);

  // Return the refresh token
  return new Response(JSON.stringify({ refresh_token: refreshToken, newUser: isNewUser }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Create or retrieve an existing refresh token.
 * If the user is not currently in the database, their account must be created and given a refresh token.
 */
async function retrieveRefreshToken(env, uuid, username, email) {
  const now = Math.floor(Date.now() / 1000); // Current unix timestamp in seconds
  const expiration = now + parseInt(env.REFRESH_TOKEN_EXPIRY_SECONDS || "15552000", 10); // Refresh token expire unix timestamp in seconds

  // Step 1: Check for existing refresh token
  const existingToken = await env.PACKSYNCR_DB.prepare(`
    SELECT token_value, expires_at FROM refresh_tokens
    WHERE uuid = ?
  `).bind(uuid).first();

  // Step 2: If there is a valid unexpired token, return it
  if (existingToken && existingToken.expires_at > now + 86400) { // existing token should have at least one day left
    return {
      refreshToken: existingToken.token_value,
      isNewUser: false
    };
  }

  // Step 3: Check if the user exists in 'users' table
  const userExists = await env.PACKSYNCR_DB.prepare(`
    SELECT uuid FROM users WHERE uuid = ?
  `).bind(uuid).first();

  // Step 4: If the user does not exist, insert them into the database
  if (!userExists) {
    await env.PACKSYNCR_DB.prepare(`
      INSERT INTO users (uuid, username, email)
      VALUES (?, ?, ?)
    `).bind(uuid, username, email).run();
  }

  // Step 5: Generate a new refresh token and insert or update it in the database
  const newToken = crypto.randomUUID();
  await env.PACKSYNCR_DB.prepare(`
    INSERT INTO refresh_tokens (uuid, token_value, expires_at)
    VALUES(?, ?, ?)
    ON CONFLICT(uuid) DO UPDATE SET
      token_value = excluded.token_value,
      expires_at = excluded.expires_at
  `).bind(uuid, newToken, expiration).run();

  return {
    refreshToken: newToken,
    isNewUser: true
  };
}

/**
 * /access-token
 * Called by frontend to retrieve the user's information, which will be sent along with all future requests to verify the user's identity.
 * Cookies: { refresh_token, uuid }
 */
async function handleCreateAccess(request, env) {
  // Parse cookies
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = Object.fromEntries(
    cookieHeader.split("; ").map(c => {
      const [key, ...v] = c.split("=");
      return [key, decodeURIComponent(v.join("="))]
    })
  );

  const refreshToken = cookies.refresh_token;
  const uuid = cookies.uuid;

  // Validate presence of cookies
  if (!uuid || !refreshToken) {
    return new Response(JSON.stringify({ error: "missing_cookies" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Verify refresh token
  const isValid = await verifyRefreshToken(refreshToken, uuid, env);
  if (!isValid) {
    return new Response(JSON.stringify({ error: "invalid_refresh_token" }), {
      status: 401,
      headers: CORS_HEADERS
    });
  }

  // Generate access token
  let accessToken;
  try {
    accessToken = await generateJWT(uuid, "access", env);
  } catch (err) {
    return new Response(JSON.stringify({ error: "token_generation_failed" }), {
      status: 500,
      headers: CORS_HEADERS
    });
  }

  // Return the access token
  return new Response(JSON.stringify({ access_token: accessToken }), {
    status: 200,
    headers: CORS_HEADERS
  });
}

/**
 * Verify the user provided the correct refresh token for the uuid they are acting as
 */
async function verifyRefreshToken(refreshToken, uuid, env) {
  try {
    // Query the refresh token from the database
    const result = await env.PACKSYNCR_DB.prepare(`
      SELECT token_value, expires_at
      FROM refresh_tokens
      WHERE uuid = ?
    `).bind(uuid).first();

    if (!result) {
      return false;
    }

    // Check if the refresh token matches and is not expired
    const now = Math.floor(Date.now() / 1000);
    const expireTime = result.expires_at;
    if (result.token_value !== refreshToken || now > expireTime) {
      return false;
    }
    return true;
  } catch (err) {
    console.error("Error verifying refresh token", err);
    return false;
  }
}

/**
 * /logout
 * Called by frontend to sign out all users by changing the refresh token.
 * Authorization: Bearer <access_token>
 */
async function handleLogout(request, env) {
  // Extract Authorization header
  const auth = request.headers.get("Authorization") || "";

  if (!auth.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "missing_bearer_token" }), {
      status: 401,
      headers: CORS_HEADERS
    });
  }

  const accessToken = auth.substring("Bearer ".length).trim();

  // Verify access token
  let payload;
  try {
    payload = await verifyJWT(accessToken, "access", env);
  } catch (err) {
    return new Response(JSON.stringify({ error: "invalid_access_token" }), {
      status: 401,
      headers: CORS_HEADERS
    });
  }

  // Extract UUID from token payload
  const uuid = payload.sub;
  if (!uuid) {
    return new Response(JSON.stringify({ error: "invalid_token_payload" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Rotate refresh token (logs out all devices)
  try {
    await signOutAllDevices(uuid, env);
  } catch (err) {
    console.error("Logout failed:", err);
    return new Response(JSON.stringify({ error: "logout_failed" }), {
      status: 500,
      headers: CORS_HEADERS
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: CORS_HEADERS
  });
}

/**
 * Sign out all devices for a specific uuid be changing the refresh token.
 */
async function signOutAllDevices(uuid, env) {
  const now = Math.floor(Date.now() / 1000); // Current unix timestamp in seconds
  const expiration = now + parseInt(env.REFRESH_TOKEN_EXPIRY_SECONDS || "15552000", 10); // Refresh token expire unix timestamp in seconds

  // Generate a new refresh token
  const newToken = crypto.randomUUID();

  // Update refresh token if it exists for this uuid
  const result = await env.PACKSYNCR_DB.prepare(`
    UPDATE refresh_tokens
    SET token_value = ?, expires_at = ?
    WHERE uuid = ?
  `).bind(newToken, expiration, uuid).run();

  return result;
}
