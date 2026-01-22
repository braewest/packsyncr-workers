/**
 * pack-handler
 * 
 * Environment Variables:
 * - JWT_SECRET (string)
 * 
 * Endpoints:
 * - POST /create-pack (frontend)
 * - POST /delete-pack (frontend)
 * - POST /update-pack (frontend)
 */

import { getAccessTokenPayload } from "./utilities/jwt.js";
import { createPack, updatePack, deletePack } from "./packs.js"

const FRONTEND_ORIGIN = "https://www.packsyncr.com";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};

// Pack Rules
const PACK_NAME_MIN_LENGTH = 1;
const PACK_NAME_MAX_LENGTH = 64;
const PACK_DESCRIPTION_MAX_LENGTH = 256;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    // Handle preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (path === "/create-pack" && request.method === "POST") {
        return await handleCreatePack(request, env);
      } else if (path === "/update-pack" && request.method === "POST") {
        return await handleUpdatePack(request, env);
      } else if (path === "/delete-pack" && request.method === "POST") {
        return await handleDeletePack(request, env);
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
}

/**
 * /create-pack
 * Called by frontend to create a new resource pack.
 * Authorization: Bearer <access_token>
 */
async function handleCreatePack(request, env) {
  // Extract access token payload
  let payload;
  try {
    payload = await getAccessTokenPayload(request, env);
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
        status: 401,
        headers: CORS_HEADERS
    });
  }

  // Retrieve uuid
  const owner_uuid = payload.sub;

  // Retrieve body information
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Retrieve name (required) and description (optional)
  const { name, description } = body;
  if (!name || typeof name !== "string" || name.length < PACK_NAME_MIN_LENGTH || name.length > PACK_NAME_MAX_LENGTH) {
    return new Response(JSON.stringify({ error: "invalid_name"}), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  if (description !== undefined && (typeof description !== "string" || description.length > PACK_DESCRIPTION_MAX_LENGTH)) {
    return new Response(JSON.stringify({ error: "invalid_description" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Check if user can create a pack
  const user = await env.PACKSYNCR_DB.prepare(`
    SELECT * FROM users
    WHERE uuid = ?
  `).bind(owner_uuid).first();

  if (!user) {
    return new Response(JSON.stringify({ error: "user_not_found" }), {
      status: 404,
      headers: CORS_HEADERS
    });
  }

  if (user.packs_created >= user.packs_limit) {
    return new Response(JSON.stringify({ error: "pack_limit_reached" }), {
      status: 403,
      headers: CORS_HEADERS
    });
  }

  // Create resource pack
  try {
    await createPack(env, owner_uuid, name, description);
  } catch (err) {
    return new Response(JSON.stringify({ error: "create_pack_failed" }), {
      status: 500,
      headers: CORS_HEADERS
    });
  }

  // Pack has been created
  return new Response(JSON.stringify({ success: true }), {
    status: 201,
    headers: CORS_HEADERS
  });
}

/**
 * /update-pack
 * Called by frontend to update an existing resource pack.
 * Authorization: Bearer <access_token>
 */
async function handleUpdatePack(request, env) {
  // Extract access token payload
  let payload;
  try {
    payload = await getAccessTokenPayload(request, env);
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
        status: 401,
        headers: CORS_HEADERS
    });
  }

  // Retrieve uuid of updater
  const updater_uuid = payload.sub;

  // Retrieve body information
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Retrieve pack uuid, name and/or description
  const { pack_uuid, name, description } = body;
  if (!pack_uuid || typeof pack_uuid !== "string") {
    return new Response(JSON.stringify({ error: "invalid_pack_uuid" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  if (name === undefined && description === undefined) {
    return new Response(JSON.stringify({ error: "invalid_fields" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  if (name !== undefined && (typeof name !== "string" || name.length < PACK_NAME_MIN_LENGTH || name.length > PACK_NAME_MAX_LENGTH)) {
    return new Response(JSON.stringify({ error: "invalid_name" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  if (description !== undefined && (typeof description !== "string" || description.length > PACK_DESCRIPTION_MAX_LENGTH)) {
    return new Response(JSON.stringify({ error: "invalid_description" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Update pack information and manifest
  try {
    await updatePack(env, {
      pack_uuid,
      owner_uuid: updater_uuid,
      name,
      description
    })
  } catch (err) {
    const status = 
      err.message === "invalid_fields" ? 400 :
      err.message === "forbidden_action" ? 403 :
      err.message === "manifest_not_updated" ? 500 :
      500;

      return new Response(JSON.stringify({ error: err.message }), {
        status,
        headers: CORS_HEADERS
      });
  }

  // Pack has been updated
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: CORS_HEADERS
  });
}

/**
 * /delete-pack
 * Called by frontend to delete an existing resource pack.
 * Authorization: Bearer <access_token>
 */
async function handleDeletePack(request, env) {
  // Extract access token payload
  let payload;
  try {
    payload = await getAccessTokenPayload(request, env);
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
        status: 401,
        headers: CORS_HEADERS
    });
  }

  // Retrieve uuid of deleter
  const deleter_uuid = payload.sub;

  // Retrieve body information
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Retrieve pack uuid
  const { pack_uuid } = body;
  if (!pack_uuid || typeof pack_uuid !== "string") {
    return new Response(JSON.stringify({ error: "invalid_pack_uuid" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Delete pack and manifest
  try {
    await deletePack(env, {
      pack_uuid,
      owner_uuid: deleter_uuid
    });
  } catch (err) {
    const status = 
      err.message === "forbidden_action" ? 403 :
      err.message === "manifest_not_deleted" ? 500 :
      500;

      return new Response(JSON.stringify({ error: err.message }), {
        status,
        headers: CORS_HEADERS
      });
  }

  // Pack has been deleted
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: CORS_HEADERS
  });
}
