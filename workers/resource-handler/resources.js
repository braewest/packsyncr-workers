/**
 * RESOURCE TYPES:
 * custom: A custom resource type
 */
const RESOURCE_TYPES = ["custom"];

// Resource Rules
const RESOURCE_NAME_MIN_LENGTH = 1;
const RESOURCE_NAME_MAX_LENGTH = 64;
const RESOURCE_DESCRIPTION_MAX_LENGTH = 256;

/**
 * Create the new resource in the packsyncr database.
 */
export async function createResource(env, requester_uuid, type, name, description) {
	const resource_uuid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000); // Current unix timestamp in seconds

	// Check rules
	if (type !== undefined && !RESOURCE_TYPES.includes(type)) {
		throw new Error("invalid_resource_type");
	}
  if (name.length < RESOURCE_NAME_MIN_LENGTH || name.length > RESOURCE_NAME_MAX_LENGTH) {
    throw new Error("invalid_name_length");
  }
  if (description !== undefined && description.length > RESOURCE_DESCRIPTION_MAX_LENGTH) {
    throw new Error("invalid_description_length");
  }

	// Create resource
  await env.PACKSYNCR_DB.prepare(`
    INSERT INTO resources (
      resource_uuid,
      owner_uuid,
      type,
      name,
      description,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    resource_uuid,
    requester_uuid,
    type ?? "custom",
    name,
    description ?? null,
    now,
    now // Updated at creation time
  ).run();

	// Update user's resources_created count
  await env.PACKSYNCR_DB.prepare(`
    UPDATE users
    SET resources_created = resources_created + 1
    WHERE uuid = ?
  `).bind(requester_uuid).run();
}
