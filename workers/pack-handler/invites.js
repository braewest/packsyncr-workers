/**
 * COLLABORATOR ROLES:
 * follower: Can read all resources in a pack.
 * 
 * collaborator: Can add, update, and delete their own resources from a pack. 
 *               Can read all resources in a pack.
 * 
 * admin: Can add and update their own resources, as well as delete any resources from a pack.
 *        Can generate invite codes.
 *        Can read all resources in a pack.
 */
const COLLABORATOR_ROLES = ["follower", "collaborator", "admin"];

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
      // TODO: Check if the requester is an admin
      throw new Error("forbidden_action");
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
