import { deployment } from '../../config/deployment.mjs'

export const DB = deployment.DATABASE
export const SCHEMA_RAW = `${DB}.${deployment.RAW_SCHEMA}`
export const STAGE = `@${SCHEMA_RAW}.${deployment.PHOTO_STAGE}`
