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

import { getAccessTokenPayload } from "./jwt.js";

const FRONTEND_ORIGIN = "https://www.packsyncr.com";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};

// Pack Manifest Location
const MANIFEST_LOCATION_PREFIX = "packs/";
const MANIFEST_LOCATION_POSTFIX = "-manifest.json";

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
 * Create the new resource pack in the packsyncr database, along with an empty pack manifest
 */
async function createPack(env, owner_uuid, name, description) {
  const pack_uuid = crypto.randomUUID();
  const created_at = Math.floor(Date.now() / 1000); // Current unix timestamp in seconds

    await env.PACKSYNCR_DB.prepare(`
      INSERT INTO resource_packs (
        pack_uuid,
        owner_uuid,
        name,
        description,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      pack_uuid,
      owner_uuid,
      name,
      description ?? null,
      created_at,
      created_at // Updated at creation time
    ).run();

  // Update user's packs_created count
  await env.PACKSYNCR_DB.prepare(`
    UPDATE users
    SET packs_created = packs_created + 1
    WHERE uuid = ?
  `).bind(owner_uuid).run();

  // Create empty pack manifest in R2
  await createEmptyManifest(env, {
    pack_uuid,
    owner_uuid,
    name,
    description,
    created_at
  });
}

/**
 * Create an empty manifest for a new resource pack
 */
async function createEmptyManifest(env, {
  pack_uuid,
  owner_uuid,
  name,
  description,
  created_at
}) {
  const manifest = {
    pack: {
      uuid: pack_uuid,
      name,
      description: description ?? null,
      owner_uuid,
      created_at,
      updated_at: created_at
    },
    resources: []
  };

  const key = `${MANIFEST_LOCATION_PREFIX}${pack_uuid}${MANIFEST_LOCATION_POSTFIX}`;

  await env.MANIFEST_BUCKET.put(
    key,
    JSON.stringify(manifest,  null, 2),
    {
      httpMetadata: {
        contentType: "application/json"
      }
    }
  );
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
 * Update the information of an existing resource pack.
 */
async function updatePack(env, {
  pack_uuid,
  owner_uuid,
  name,
  description
}) {
  const now = Math.floor(Date.now() / 1000); // Current unix timestamp in seconds
  const fields = [];
  const values = [];

  if (name !== undefined) {
    fields.push("name = ?");
    values.push(name);
  }
  if (description !== undefined) {
    fields.push("description = ?");
    values.push(description);
  }
  
  // Update updated_at timestamp
  fields.push("updated_at = ?");
  values.push(now);

  values.push(pack_uuid, owner_uuid);

  // Update pack
  const result = await env.PACKSYNCR_DB.prepare(`
    UPDATE resource_packs
    SET ${fields.join(", ")}
    WHERE pack_uuid = ? AND owner_uuid = ?
  `).bind(...values).run();

  if (result.changes === 0) {
    throw new Error("forbidden_action");
  }

  // Update manifest in R2
  try {
    await updatePackManifest(env, pack_uuid, {
      name, description, now
    });
  } catch {
    throw new Error("manifest_not_updated");
  }
}

/**
 * Update the manifest for an existing resource pack.
 */
async function updatePackManifest(env, pack_uuid, updates) {
  const key = `${MANIFEST_LOCATION_PREFIX}${pack_uuid}${MANIFEST_LOCATION_POSTFIX}`;

  // Retrieve manifest from R2
  const obj = await env.MANIFEST_BUCKET.get(key);
  if (!obj) {
    throw new Error();
  }

  const manifest = JSON.parse(await obj.text());

  // Update manifest
  if (updates.name !== undefined) {
    manifest.pack.name = updates.name;
  }
  if (updates.description !== undefined) {
    manifest.pack.description = updates.description;
  }

  // Update updated_at timestamp
  manifest.pack.updated_at = updates.now;

  // Upload updated manifest
  await env.MANIFEST_BUCKET.put(
    key,
    JSON.stringify(manifest, null, 2),
    {
      httpMetadata: { contentType: "application/json" }
    }
  );
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

/**
 * Delete a resource pack.
 */
async function deletePack(env, packInfo) {
  const { pack_uuid, owner_uuid } = packInfo;

  // Delete pack
  const result = await env.PACKSYNCR_DB.prepare(`
    DELETE FROM resource_packs
    WHERE pack_uuid = ? AND owner_uuid = ?
  `).bind(pack_uuid, owner_uuid).run();

  if (result.meta.changes === 0) {
    throw new Error("forbidden_action");
  }

  // Decrement user's pack count
  await env.PACKSYNCR_DB.prepare(`
    UPDATE users
    SET packs_created = packs_created - 1
    WHERE uuid = ? AND packs_created > 0
  `).bind(owner_uuid).run();

  // Delete pack manifest
  const key = `${MANIFEST_LOCATION_PREFIX}${pack_uuid}${MANIFEST_LOCATION_POSTFIX}`;
  try {
    await env.MANIFEST_BUCKET.delete(key);
  } catch {
    throw new Error("manifest_not_deleted");
  }
}
