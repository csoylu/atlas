-- The app is named Atlas: env vars use the ATLAS_ prefix.
UPDATE models SET credential_env = 'ATLAS_LOCAL_API_KEY' WHERE credential_env = 'HARNESS_LOCAL_API_KEY';
