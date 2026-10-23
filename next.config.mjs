/** @type {import('next').NextConfig} */
const config = {
  async headers() {
    return [{
      source: "/integrations/viewer-bridge-v1.mjs",
      headers: [
        { key: "Access-Control-Allow-Origin", value: "*" },
        { key: "Content-Type", value: "text/javascript; charset=utf-8" },
        { key: "Cache-Control", value: "public, max-age=300" },
      ],
    }]
  },
}
export default config
