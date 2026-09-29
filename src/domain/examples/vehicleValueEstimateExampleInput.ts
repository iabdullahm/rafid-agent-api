/** vehicle_value_estimate's registry example input: the canonical request from the capability
 *  specification (a 2022 Toyota Land Cruiser GXR, 68,000 km, Muscat, asking OMR 22,500). On a
 *  deployment with no market-data provider covering Oman, executing it returns an honest
 *  `insufficient_market_data` result; the documented exampleOutput is generated from synthetic
 *  fixtures (see vehicleValueEstimateExample.ts). */
export const VEHICLE_EXAMPLE_INPUT = {
  make: "Toyota", model: "Land Cruiser", year: 2022, trim: "GXR", mileageKm: 68000, condition: "good",
  country: "Oman", city: "Muscat", currency: "OMR", fuelType: "petrol", transmission: "automatic", bodyType: "suv",
  engine: "4.0L V6", drivetrain: "4WD", accidentHistory: false, serviceHistory: "full", owners: 1, color: "white",
  options: ["sunroof", "leather seats", "360 camera"], askingPrice: 22500
};
