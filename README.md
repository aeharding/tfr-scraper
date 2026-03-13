# tfr-scraper

AWS Lambda service that scrapes FAA Temporary Flight Restrictions (TFRs) and stores them in MongoDB for geo-querying.

## Architecture

Two Lambda functions deployed via Serverless Framework:

- **scraper** -- Runs every 15 minutes. Fetches the current TFR list and geometry from the [FAA WFS GeoJSON endpoint](https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=300&outputFormat=application/json), then retrieves detailed NOTAM data from the [FAA NMS-API](https://api-nms.aim.faa.gov/nmsapi/v1). Results are stored in MongoDB with a 2dsphere index.
- **query** -- `GET /api/tfr?lat=...&lon=...&radialDistance=...` returns TFRs within the given radius (meters).

## Prerequisites

- Node.js 24+
- [Serverless Framework v3](https://www.serverless.com/framework/docs/getting-started)
- AWS CLI configured with credentials (`aws configure`)
- A MongoDB Atlas cluster
- FAA NMS-API credentials (email [7-AWA-NAIMES@faa.gov](mailto:7-AWA-NAIMES@faa.gov) to request access)

## Setup

### 1. Install dependencies

```bash
yarn install
```

### 2. Create config file

Create a `config.prod.json` in the project root (gitignored):

```json
{
  "MONGODB_USER": "your-mongodb-user",
  "MONGODB_PASSWORD": "your-mongodb-password",
  "MONGODB_HOST": "your-cluster.mongodb.net",
  "NMS_API_HOST": "https://api-nms.aim.faa.gov",
  "NMS_API_KEY": "your-nms-api-key",
  "NMS_API_SECRET": "your-nms-api-secret"
}
```

For other stages, create `config.<stage>.json` (e.g. `config.dev.json`).

## Deployment

```bash
npx serverless deploy --stage prod
```

To deploy to a different stage:

```bash
npx serverless deploy --stage dev
```

## Invoking manually

Trigger the scraper on-demand:

```bash
npx serverless invoke --function scraper --stage prod
```

Test the query endpoint:

```bash
curl "https://<api-id>.execute-api.us-east-1.amazonaws.com/api/tfr?lat=38.85&lon=-77.04&radialDistance=50000"
```
