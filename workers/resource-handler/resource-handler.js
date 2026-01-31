/**
 * resource-handler
 * 
 * Environment Variables:
 * - JWT_SECRET (string)
 * 
 * Endpoints:
 * - POST /create-resource (frontend)
 * - POST /update-resource (frontend)
 * - POST /delete-resource (frontend)
 * 
 * - POST /create-invite (frontend)
 * - POST /delete-invite (frontend)
 * 
 * - POST /upload-file (frontend)
 */

import { getAccessTokenPayload } from "./utilities/jwt.js";
import { createResource, updateResource, deleteResource } from "./resources.js";
import { createInvite, deleteInvite } from "./invites.js";
import { uploadFile } from "./files.js";

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
      if (path === "/delete-resource" && request.method === "POST") {
        return await handleDeleteResource(request, env);
      }
      if (path === "/create-invite" && request.method === "POST") {
        return await handleCreateInvite(request, env);
      }
      if (path === "/delete-invite" && request.method === "POST") {
        return await handleDeleteInvite(request, env);
      }
      if (path === "/upload-file" && request.method === "POST") {
        return await handleUploadFile(request, env);
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

/**
 * /delete-resource
 * Called by frontend to delete an existing resource owner by the requester.
 * Authorization: Bearer <access_token>
 */
async function handleDeleteResource(request, env) {
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

  // Retrieve resource_uuid
  const { resource_uuid } = body;
  if (!resource_uuid || typeof resource_uuid !== "string") {
    return new Response(JSON.stringify({ error: "invalid_resource_uuid" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Delete exisiting resource
  try {
    await deleteResource(env, resource_uuid, requester_uuid);
  } catch (err) {
    const status = 
      err.message === "forbidden_action" ? 403 :
      500;

      return new Response(JSON.stringify({ error: err.message }), {
        status,
        headers: CORS_HEADERS
      });
  }

  // Resource has been deleted
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: CORS_HEADERS
  });
}

/**
 * /create-invite
 * Called by frontend to create an invite code for a resource.
 * Authorization: Bearer <access_token>
 */
async function handleCreateInvite(request, env) {
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

  // Retrieve resource_uuid, duration (optional), and max_uses (optional)
  const { resource_uuid, duration, max_uses } = body;
  if (!resource_uuid || typeof resource_uuid !== "string") {
    return new Response(JSON.stringify({ error: "invalid_resource_uuid" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Create invite code
  let invite_code;
  try {
    invite_code = await createInvite(env, resource_uuid, requester_uuid, duration, max_uses);
  } catch (err) {
    const status = 
      err.message === "invalid_duration" ? 400 :
      err.message === "invalid_max_uses" ? 400 :
      err.message === "forbidden_action" ? 403 :
      err.message === "resource_not_found" ? 404 :
      err.message === "db_insert_failed" ? 500 :
      500;

      return new Response(JSON.stringify({ error: err.message }), {
        status,
        headers: CORS_HEADERS
      });
  }

  // Invite has been created
  return new Response(JSON.stringify({ invite_code }), {
    status: 200,
    headers: CORS_HEADERS
  });
}

/**
 * /delete-invite
 * Called by frontend to delete an invite code for a resource.
 * Authorization: Bearer <access_token>
 */
async function handleDeleteInvite(request, env) {
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

  // Retrieve invite_code
  const { invite_code } = body;
  if (!invite_code || typeof invite_code !== "string") {
    return new Response(JSON.stringify({ error: "invalid_invite_code" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Delete invite
  try {
    await deleteInvite(env, invite_code, requester_uuid);
  } catch (err) {
    const status = 
      err.message === "forbidden_action" ? 403 :
      err.message === "invite_not_found" ? 404 :
      err.message === "resource_not_found" ? 404 :
      500;

    return new Response(JSON.stringify({ error: err.message }), {
      status,
      headers: CORS_HEADERS
    });
  }

  // Invite has been deleted
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: CORS_HEADERS
  });
}

/**
 * /upload-file
 * Called by frontend to upload a file to a resource using multipart form data.
 * Authorization: Bearer <access_token>
 * Content-Type: multipart/form-data; boundary=<boundary>
 */
async function handleUploadFile(request, env) {
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

  // Get request body
  const request_body = request.body;
  if (!request_body) {
    throw new Error("invalid_body");
  }

  // Ensure request is multipart/form-data
  const content_type = request.headers.get("content-type") || "";
  if (!content_type.includes("multipart/form-data")) {
    return new Response(JSON.stringify({ error: "invalid_content_type" }), {
      status: 400,
      headers: CORS_HEADERS
    });
  }

  // Get boundary
  const match = content_type.match(/boundary=(.+)$/);
  const boundary = "--" + match[1];

  let testString;
  try {
    // Pass the raw request body stream to uploadFile
    testString = await uploadFile(env, requester_uuid, request_body, boundary);
  } catch (err) {
    const status = 
      err.message === "invalid_body" ? 400 :
      err.message === "missing_resource_uuid" ? 400 :
      err.message === "missing_file_directory" ? 400 :
      err.message === "missing_file_name" ? 400 :
      err.message === "missing_content_type" ? 400 :
      err.message === "missing_file" ? 400 :
      err.message === "file_type_mismatch" ? 400 :
      err.message === "forbidden_action" ? 403 :
      err.message === "forbidden_content_type" ? 403 :
      err.message === "forbidden_file_directory" ? 403 :
      err.message === "resource_not_found" ? 404 :
      err.message === "file_too_large" ? 413 :
      err.message === "undefined_resource_type" ? 500 :
      err.message === "r2_upload_failed" ? 500 :
      err.message === "d1_upload_failed" ? 500 :
      500;

    return new Response(JSON.stringify({ error: err.message }), {
      status,
      headers: CORS_HEADERS
    });
  }

  // File has been uploaded
  return new Response(JSON.stringify({ success: testString }), {
    status: 201,
    headers: CORS_HEADERS
  });
}
