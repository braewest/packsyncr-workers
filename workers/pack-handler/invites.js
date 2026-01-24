/**
 * COLLABORATOR ROLES:
 * follower: Can read all resources in a pack.
 * 
 * collaborator: Can add, update, and delete their own resources from a pack. 
 *               Can read all resources in a pack.
 * 
 * admin: Can add and update their own resources, as well as delete any resources from a pack.
 *        Can generate invite codes (excluding admin invites).
 *        Can read all resources in a pack.
 */
const COLLABORATOR_ROLES = ["follower", "collaborator", "admin"]; // TODO: add owner role
const ROLE_PRIORITY = {
  follower: 1,
  collaborator: 2,
  admin: 3
};

const MINIMUM_SET_DURATION = 300;
const MINIMUM_SET_MAX_USES = 1;

/**
 * Create an invite code for joining a resource pack. Roles determine what permissions you have. Can set a duration (seconds) and max uses for a code.
 */
export async function createPackInvite(env, pack_uuid, requester_uuid, role, duration, max_uses) {
    const now = Math.floor(Date.now() / 1000);

    if (!COLLABORATOR_ROLES.includes(role)) {
        throw new Error("invalid_role");
    }

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

    // Retrieve pack to check if the request is the owner
    const pack = await env.PACKSYNCR_DB.prepare(`
      SELECT owner_uuid
      FROM resource_packs
      WHERE pack_uuid = ?
    `).bind(pack_uuid).first();

    if (!pack) {
      throw new Error("pack_not_found");
    }

    if (pack.owner_uuid !== requester_uuid) {
      // Check if the requester is an admin
      const collaborator = await env.PACKSYNCR_DB.prepare(`
        SELECT role
        FROM pack_collaborators
        WHERE pack_uuid = ? AND user_uuid = ?
      `).bind(pack_uuid, requester_uuid).first();

      if (!collaborator || collaborator.role !== "admin" || role === "admin") { // Admins cannot generate invite codes for admin role
        throw new Error("forbidden_action");
      }
    }

    // Generate unique invite code
    const invite_code = "p-" + crypto.randomUUID();

    // Insert invite code into database
    try {
      await env.PACKSYNCR_DB.prepare(`
        INSERT INTO pack_invite_codes (
          invite_code,
          pack_uuid,
          role,
          creator_uuid,
          created_at,
          expires_at,
          max_uses,
          uses
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(invite_code, pack_uuid, role, requester_uuid, now, expiration, allowed_uses, 0).run();
    } catch {
      throw new Error("db_insert_failed");
    }

    return invite_code;
}

/**
 * Redeem an invite code to join a resource pack. Roles determine what permissions you have.
 */
export async function redeemPackInvite(env, invite_code, requester_uuid) {
  const now = Math.floor(Date.now() / 1000);

  // Fetch invite
  const invite = await env.PACKSYNCR_DB.prepare(`
    SELECT *
    FROM pack_invite_codes
    WHERE invite_code = ?
  `).bind(invite_code).first();

  if (!invite) {
    throw new Error("invite_not_found");
  }

  // Check expiration
  if (invite.expires_at !== -1 && invite.expires_at < now) {
    await deleteInviteFromCode(env, invite_code);
    throw new Error("invite_expired");
  }

  // Check uses
  if (invite.max_uses !== -1 && invite.uses >= invite.max_uses) {
    await deleteInviteFromCode(env, invite_code);
    throw new Error("invite_used_up");
  }

  // Check if already an existing collaborator
  const existing = await env.PACKSYNCR_DB.prepare(`
    SELECT role
    FROM pack_collaborators
    WHERE pack_uuid = ? AND user_uuid = ?
  `).bind(invite.pack_uuid, requester_uuid).first();

  if (existing) {
    // If existing role priority is higher or equal, do nothing
    if (ROLE_PRIORITY[existing.role] >= ROLE_PRIORITY[invite.role]) {
      return; // User will still get a 200 status code because they are a collaborator at or above the redeemable level
    }
  }

  // Check if user can follow another pack (unless they already have an existing role)
  if (!existing) {
    // Fetch requester information
    const user = await env.PACKSYNCR_DB.prepare(`
      SELECT packs_followed, follow_limit
      FROM users
      WHERE uuid = ?
    `).bind(requester_uuid).first();

    if (!user) {
      throw new Error("user_not_found");
    }
    if (user.packs_followed >= user.follow_limit) {
      throw new Error("follow_limit_reached");
    }

    // Increment follow count
    try {
      await env.PACKSYNCR_DB.prepare(`
        UPDATE users
        SET packs_followed = packs_followed + 1
        WHERE uuid = ?
      `).bind(requester_uuid).run();
    } catch {
      throw new Error("increment_follow_count_failed");
    }
  }

  // Add collaborator
  try {
    await env.PACKSYNCR_DB.prepare(`
      INSERT OR REPLACE INTO pack_collaborators (
        pack_uuid,
        user_uuid,
        role,
        joined_at
      ) VALUES (?, ?, ?, ?)
    `).bind(invite.pack_uuid, requester_uuid, invite.role, now).run();
  } catch {
    throw new Error("redeem_failed");
  }

  // Increment invite use and check if invite can be deleted
  if (invite.max_uses !== -1 && invite.uses + 1 >= invite.max_uses) {
    await deleteInviteFromCode(env, invite_code);
  } else {
    // Increment invite code uses
    await env.PACKSYNCR_DB.prepare(`
      UPDATE pack_invite_codes
      SET uses = uses + 1
      WHERE invite_code = ?
    `).bind(invite_code).run();
  }
}

/**
 * Delete an invite code for a resource pack if requester is the invite creator or owner
 */
export async function deleteInvite(env, invite_code, requester_uuid) {
  // Fetch invite
  const invite = await env.PACKSYNCR_DB.prepare(`
    SELECT pack_uuid, creator_uuid
    FROM pack_invite_codes
    WHERE invite_code = ?
  `).bind(invite_code).first();

  if (!invite) {
    throw new Error("invite_not_found");
  }

  // Check if requester is able to delete the invite code (creator or pack owner)
  if (invite.creator_uuid !== requester_uuid) {
    // Fetch pack to get the owner
    const pack = await env.PACKSYNCR_DB.prepare(`
      SELECT owner_uuid
      FROM resource_packs
      WHERE pack_uuid = ?
    `).bind(invite.pack_uuid).first();

    if (!pack) {
      throw new Error("pack_not_found");
    }

    // Check if requester is owner
    if (pack.owner_uuid !== requester_uuid) {
      throw new Error("forbidden_action");
    }
  }

  // Delete invite
  await deleteInviteFromCode(env, invite_code);
}

// Deletes pack invite code
async function deleteInviteFromCode(env, invite_code) {
  await env.PACKSYNCR_DB.prepare(`
    DELETE FROM pack_invite_codes
    WHERE invite_code = ?
  `).bind(invite_code).run();
}

/**
 * Add a resource to a pack if requester has authorization.
 */
export async function addResourceToPack(env, pack_uuid, requester_uuid, invite_code) {
  const now = Math.floor(Date.now() / 1000);

  // Check if pack can follow another resource
  const pack = await env.PACKSYNCR_DB.prepare(`
    SELECT resources_used, resources_limit
    FROM resource_packs
    WHERE pack_uuid = ?
  `).bind(pack_uuid).first();

  if (!pack) {
    throw new Error("pack_not_found");
  }
  if (pack.resources_used >= pack.resources_limit) {
    throw new Error("resource_limit_reached");
  }

  // Retrieve user to check auhtority level
  const user = await env.PACKSYNCR_DB.prepare(`
    SELECT role
    FROM pack_collaborators
    WHERE pack_uuid = ? AND user_uuid = ?
  `).bind(pack_uuid, requester_uuid).first();

  // Check user's authority level
  if (!user || ROLE_PRIORITY[user.role] < ROLE_PRIORITY["collaborator"]) {
    throw new Error("unauthorized_action");
  }

  // Fetch invite
  const invite = await env.PACKSYNCR_DB.prepare(`
    SELECT *
    FROM resource_invite_codes
    WHERE invite_code = ?
  `).bind(invite_code).first();

  if (!invite) {
    throw new Error("invite_not_found");
  }

  // Check expiration
  if (invite.expires_at !== -1 && invite.expires_at < now) {
    await deleteInviteFromResourceCode(env, invite_code);
    throw new Error("invite_expired");
  }

  // Check uses
  if (invite.max_uses !== -1 && invite.uses >= invite.max_uses) {
    await deleteInviteFromResourceCode(env, invite_code);
    throw new Error("invite_used_up");
  }

  // Add resource
  try {
    await env.PACKSYNCR_DB.prepare(`
      INSERT INTO pack_resources (
        pack_uuid,
        resource_uuid,
        added_by,
        added_at
      ) VALUES (?, ?, ?, ?)
    `).bind(pack_uuid, invite.resource_uuid, requester_uuid, now).run();
  } catch {
    throw new Error("redeem_failed");
  }

  // Increment resource count
  try {
    await env.PACKSYNCR_DB.prepare(`
        UPDATE resource_packs
        SET resources_used = resources_used + 1
        WHERE pack_uuid = ?
      `).bind(pack_uuid).run();
  } catch {
    throw new Error("increment_resource_count_failed");
  }

  // Increment invite use and check if invite can be deleted
  if (invite.max_uses !== -1 && invite.uses + 1 >= invite.max_uses) {
    await deleteInviteFromResourceCode(env, invite_code);
  } else {
    // Increment invite code uses
    await env.PACKSYNCR_DB.prepare(`
      UPDATE resource_invite_codes
      SET uses = uses + 1
      WHERE invite_code = ?
    `).bind(invite_code).run();
  }
}

/**
 * Remove a resource from a pack if requester has authorization (collaborator that added it or admin).
 */
export async function removeResourceFromPack(env, pack_uuid, resource_uuid, requester_uuid) {
  // Fetch resource and pack link
  const resource = await env.PACKSYNCR_DB.prepare(`
    SELECT added_by
    FROM pack_resources
    WHERE pack_uuid = ? AND resource_uuid = ?
  `).bind(pack_uuid, resource_uuid).first();

  if (!resource) {
    throw new Error("pack_resource_not_found");
  }

  // Retrieve user to check auhtority level
  const user = await env.PACKSYNCR_DB.prepare(`
    SELECT role
    FROM pack_collaborators
    WHERE pack_uuid = ? AND user_uuid = ?
  `).bind(pack_uuid, requester_uuid).first();

  if (!user) {
    throw new Error("user_not_found");
  }

  // Check user's authority level
  const isAdmin = ROLE_PRIORITY[user.role] >= ROLE_PRIORITY["admin"];
  const isAdderCollaborator = resource.added_by === requester_uuid && ROLE_PRIORITY[user.role] >= ROLE_PRIORITY["collaborator"]

  if (!isAdmin && !isAdderCollaborator) {
    throw new Error("unauthorized_action");
  }

  // Remove resource from pack
  const result = await env.PACKSYNCR_DB.prepare(`
    DELETE FROM pack_resources
    WHERE pack_uuid = ? AND resource_uuid = ?
  `).bind(pack_uuid, resource_uuid).run();

  if (result.meta.changes !== 1) {
    throw new Error("remove_failed");
  }

  // Decrement resource count
  await env.PACKSYNCR_DB.prepare(`
    UPDATE resource_packs
    SET resources_used = resources_used - 1
    WHERE pack_uuid = ? AND resources_used > 0
  `).bind(pack_uuid).run();
}

// Deletes resource invite code
async function deleteInviteFromResourceCode(env, invite_code) {
  await env.PACKSYNCR_DB.prepare(`
    DELETE FROM resource_invite_codes
    WHERE invite_code = ?
  `).bind(invite_code).run();
}
