const MINIMUM_SET_DURATION = 300;
const MINIMUM_SET_MAX_USES = 1;

/**
 * Create an invite code for adding a resource to a pack. Can set a duration (seconds) and max uses for a code.
 */
export async function createInvite(env, resource_uuid, requester_uuid, duration, max_uses) {
  const now = Math.floor(Date.now() / 1000);

  // Validate duration if defined
  let expiration = -1;
  if (duration !== undefined) {
      if (!Number.isInteger(duration) || duration < MINIMUM_SET_DURATION) {
          throw new Error("invalid_duration");
      }
      expiration = now + duration
  }

  // Validate uses if defined
  let allowed_uses = -1;
  if (max_uses !== undefined) {
      if (!Number.isInteger(max_uses) || max_uses < MINIMUM_SET_MAX_USES) {
          throw new Error("invalid_max_uses");
      }
      allowed_uses = max_uses;
  }

  // Retrieve resource to check if the request is the owner
  const resource = await env.PACKSYNCR_DB.prepare(`
    SELECT owner_uuid
    FROM resources
    WHERE resource_uuid = ?
  `).bind(resource_uuid).first();

  if (!resource) {
    throw new Error("resource_not_found");
  }

  if (resource.owner_uuid !== requester_uuid) {
    throw new Error("forbidden_action");
  }

  // Generate unique invite code
  const invite_code = "r-" + crypto.randomUUID();

  // Insert invite code into database
  try {
    await env.PACKSYNCR_DB.prepare(`
      INSERT INTO resource_invite_codes (
        invite_code,
        resource_uuid,
        creator_uuid,
        created_at,
        expires_at,
        max_uses,
        uses
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(invite_code, resource_uuid, requester_uuid, now, expiration, allowed_uses, 0).run();
  } catch {
    throw new Error("db_insert_failed");
  }

  return invite_code;
}

/**
 * Delete an invite code for a resource if requester is the owner (invite creator)
 */
export async function deleteInvite(env, invite_code, requester_uuid) {
  // Fetch invite
  const invite = await env.PACKSYNCR_DB.prepare(`
    SELECT creator_uuid
    FROM resource_invite_codes
    WHERE invite_code = ?
  `).bind(invite_code).first();

  if (!invite) {
    throw new Error("invite_not_found");
  }

  // Check if requester is able to delete the invite code (invite creator)
  if (invite.creator_uuid !== requester_uuid) {
    throw new Error("forbidden_action");
  }

  // Delete invite
  await deleteInviteFromCode(env, invite_code);
}

async function deleteInviteFromCode(env, invite_code) {
  await env.PACKSYNCR_DB.prepare(`
    DELETE FROM resource_invite_codes
    WHERE invite_code = ?
  `).bind(invite_code).run();
}
