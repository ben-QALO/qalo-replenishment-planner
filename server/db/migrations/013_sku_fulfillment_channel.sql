-- Each SKU is either fulfilled by Amazon (FBA) or by the merchant (FBM). The tool ships
-- warehouse stock to Amazon only for FBA SKUs; an FBM SKU is fulfilled from the warehouse
-- directly and must NEVER get a warehouse→FBA transfer recommendation. This is a manually
-- maintained flag (default 'fba', since every SKU in the catalog came from an FBA export).
-- An FBM SKU's Business-Report demand still folds onto the FBA SKU of the same ASIN (see
-- import/attribute-demand.ts), so the product's demand is planned once, on the FBA SKU.
ALTER TABLE skus ADD COLUMN fulfillment_channel TEXT NOT NULL DEFAULT 'fba';
