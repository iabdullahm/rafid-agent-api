const swaggerVersion = "5.32.11";
const assetBase = `https://unpkg.com/swagger-ui-dist@${swaggerVersion}`;

export const swaggerHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Interactive documentation for the Rafid Agent API">
    <title>Rafid Agent API Docs</title>
    <link rel="stylesheet" href="${assetBase}/swagger-ui.css" crossorigin="anonymous">
    <style>
      html { box-sizing: border-box; overflow-y: scroll; }
      *, *::before, *::after { box-sizing: inherit; }
      body { margin: 0; background: #f5f7fb; }
      .swagger-ui .topbar { background: #10253f; }
      .swagger-ui .topbar-wrapper img { display: none; }
      .swagger-ui .topbar-wrapper::before { color: #fff; content: "Rafid Agent API"; font: 600 18px/1 system-ui, sans-serif; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${assetBase}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
    <script>
      window.addEventListener("load", function () {
        window.ui = SwaggerUIBundle({
          url: "/openapi.json",
          dom_id: "#swagger-ui",
          deepLinking: true,
          displayRequestDuration: true,
          filter: true,
          persistAuthorization: false,
          tryItOutEnabled: true,
          validatorUrl: null,
          presets: [SwaggerUIBundle.presets.apis],
          layout: "BaseLayout"
        });
      });
    </script>
  </body>
</html>`;

export const swaggerContentSecurityPolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src https://unpkg.com data:",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "script-src https://unpkg.com 'unsafe-inline'",
  "style-src https://unpkg.com 'unsafe-inline'"
].join("; ");
