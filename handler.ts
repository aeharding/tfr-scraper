import runScraper from "./scraper";
import runQuery from "./query";

// Interval between scraper runs
const REFRESH_TIME_IN_MINUTES = 15;

export async function scraper(): Promise<AWSLambda.APIGatewayProxyResultV2> {
  try {
    await runScraper();
  } catch (error) {
    console.log(error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error processing TFRs" }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Successfully processed TFRs",
    }),
  };
}

export async function query(
  event: AWSLambda.APIGatewayEvent
): Promise<AWSLambda.APIGatewayProxyResultV2> {
  const lat = Number(event.queryStringParameters?.lat);
  const lon = Number(event.queryStringParameters?.lon);
  const radialDistance = Number(event.queryStringParameters?.radialDistance);

  if (isNaN(lat) || isNaN(lon) || isNaN(radialDistance)) {
    return {
      statusCode: 405,
    };
  }

  try {
    var { items, lastRefreshedDate } = await runQuery({
      lat,
      lon,
      radialDistance,
    });
  } catch (error) {
    console.log(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error retrieving TFRs" }),
    };
  }

  const expiresDate = lastRefreshedDate
    ? new Date(lastRefreshedDate.getTime() + 15 * 60000)
    : new Date(0);

  return {
    statusCode: 200,
    body: JSON.stringify({ items, expiresDate }),
    headers: {
      expires: expiresDate.toUTCString(),
      "content-type": "application/json",
    },
  };
}
