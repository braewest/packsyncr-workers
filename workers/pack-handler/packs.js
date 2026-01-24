// Pack Manifest Location
const MANIFEST_LOCATION_PREFIX = "packs/";
const MANIFEST_LOCATION_POSTFIX = "-manifest.json";

// Pack Rules
const PACK_NAME_MIN_LENGTH = 1;
const PACK_NAME_MAX_LENGTH = 64;
const PACK_DESCRIPTION_MAX_LENGTH = 256;

/**
 * Create the new resource pack in the packsyncr database, along with an empty pack manifest
 */
export async function createPack(env, owner_uuid, name, description) {
  const pack_uuid = crypto.randomUUID();
  const created_at = Math.floor(Date.now() / 1000); // Current unix timestamp in seconds

  // Check rules
  if (name.length < PACK_NAME_MIN_LENGTH || name.length > PACK_NAME_MAX_LENGTH) {
    return new Error("invalid_name_length");
  }
  if (description !== undefined && description.length > PACK_DESCRIPTION_MAX_LENGTH) {
    return new Error("invalid_description_length");
  }

  // Create resource pack
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
 * Update the information of an existing resource pack.
 */
export async function updatePack(env, {
    pack_uuid,
    owner_uuid,
    name,
    description
  }) {
  const now = Math.floor(Date.now() / 1000); // Current unix timestamp in seconds

  // Check rules
  if (name !== undefined && (name.length < PACK_NAME_MIN_LENGTH || name.length > PACK_NAME_MAX_LENGTH)) {
    return new Error("invalid_name_length");
  }
  if (description !== undefined && description.length > PACK_DESCRIPTION_MAX_LENGTH) {
    return new Error("invalid_description_length");
  }
  
  // Keep list of necessary changes
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
 * Delete a resource pack.
 */
export async function deletePack(env, packInfo) {
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
