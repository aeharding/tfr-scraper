import runScraper from "./scraper";
import runQuery from "./query";

export async function scraper(event) {
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
    body: JSON.stringify(
      {
        message: "Successfully processed TFRs",
        input: event,
      },
      null,
      2
    ),
  };
}

export async function query(event) {
  const lat = +event.queryStringParameters.lat;
  const lon = +event.queryStringParameters.lon;
  const radialDistance = +event.queryStringParameters.radialDistance;

  if (isNaN(lat) || isNaN(lon) || isNaN(radialDistance)) {
    return {
      statusCode: 405,
    };
  }

  const items = await runQuery({ lat, lon, radialDistance });

  return {
    items,
  };
}
