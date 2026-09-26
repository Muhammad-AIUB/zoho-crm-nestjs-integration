import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  ZOHO_CLIENT_ID: Joi.string().required(),
  ZOHO_CLIENT_SECRET: Joi.string().required(),
  ZOHO_REDIRECT_URI: Joi.string().uri().required(),
  ZOHO_ACCOUNTS_URL: Joi.string().uri().default('https://accounts.zoho.com'),
  ZOHO_API_DOMAIN: Joi.string().uri().default('https://www.zohoapis.com'),
  // One JSON file per tenant is written here: {TOKEN_STORE_DIR}/{tenantId}.json
  TOKEN_STORE_DIR: Joi.string().default('tokens'),
});
