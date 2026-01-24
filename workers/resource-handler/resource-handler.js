/**
 * resource-handler
 * 
 * Environment Variables:
 * - JWT_SECRET (string)
 * 
 * Endpoints:
 * - POST /create-resource (frontend)
 * - POST /update-resource (frontend)
 */

import { getAccessTokenPayload } from "./utilities/jwt.js";
import { createResource, updateResource } from "./resources.js";

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
      // Request Handler
      if (path === "/create-resource" && request.method === "POST") {
        return await handleCreateResource(request, env);
      }
      if (path === "/update-resource" && request.method === "POST") {
        return await handleUpdateResource(request, env);
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
 * /create-resource
 * Called by frontend to create a new resource.
 * Authorization: Bearer <access_token>
 */
async function handleCreateResource(request, env) {
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
  const requester_uuid = payload.sub;

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

  // Retrieve type (optional), name (required), and description (optional)
  const { type, name, description } = body;
  if (type !== undefined && typeof type !== "string") {
    return new Response(JSON.stringify({ error: "invalid_type"}), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  if (!name || typeof name !== "string") {
    return new Response(JSON.stringify({ error: "invalid_name"}), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  if (description !== undefined && typeof description !== "string") {
    return new Response(JSON.stringify({ error: "invalid_description" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Check if user can create a resource
  const user = await env.PACKSYNCR_DB.prepare(`
    SELECT * FROM users
    WHERE uuid = ?
  `).bind(requester_uuid).first();

  if (!user) {
    return new Response(JSON.stringify({ error: "user_not_found" }), {
      status: 404,
      headers: CORS_HEADERS
    });
  }

  if (user.resources_created >= user.resources_limit) {
    return new Response(JSON.stringify({ error: "resource_limit_reached" }), {
      status: 403,
      headers: CORS_HEADERS
    });
  }

  // Create resource
  try {
    await createResource(env, requester_uuid, type, name, description);
  } catch (err) {
    const status = 
      err.message === "invalid_resource_type" ? 400 :
      err.message === "invalid_name_length" ? 400 :
      err.message === "invalid_description_length" ? 400 :
      err.message === "forbidden_action" ? 403 :
      500;

      return new Response(JSON.stringify({ error: err.message }), {
        status,
        headers: CORS_HEADERS
      });
  }

  // Resource has been created
  return new Response(JSON.stringify({ success: true }), {
    status: 201,
    headers: CORS_HEADERS
  });
}

/**
 * /update-resource
 * Called by frontend to update an existing resource.
 * Authorization: Bearer <access_token>
 */
async function handleUpdateResource(request, env) {
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
  const requester_uuid = payload.sub;

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

  // Retrieve resource_uuid, name and/or description
  const { resource_uuid, name, description } = body;
  if (!resource_uuid || typeof resource_uuid !== "string") {
    return new Response(JSON.stringify({ error: "invalid_resource_uuid" }), {
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
  if (name !== undefined && typeof name !== "string") {
    return new Response(JSON.stringify({ error: "invalid_name" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  if (description !== undefined && typeof description !== "string") {
    return new Response(JSON.stringify({ error: "invalid_description" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Update resource information
  try {
    await updateResource(env, resource_uuid, requester_uuid, name, description);
  } catch (err) {
    const status = 
      err.message === "invalid_fields" ? 400 :
      err.messgae === "invalid_name_length" ? 400 :
      err.message === "invalid_description_length" ? 400 :
      err.message === "forbidden_action" ? 403 :
      500;

      return new Response(JSON.stringify({ error: err.message }), {
        status,
        headers: CORS_HEADERS
      });
  }

  // Resource has been updated
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: CORS_HEADERS
  });
}
