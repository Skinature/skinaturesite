import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // react-pdf ships its own binaries/fonts; keep it out of the bundler.
  serverExternalPackages: ['@react-pdf/renderer'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
    ],
  },
  // The product videos are by far the heaviest files on the site. Let browsers
  // keep them (and their poster frames) for 30 days so a returning visitor does
  // not download them again. If a video is ever replaced, give it a new file name.
  async headers() {
    const longCache = [
      { key: 'Cache-Control', value: 'public, max-age=2592000, stale-while-revalidate=86400' },
    ];
    return [
      { source: '/:dir*/:file(.*\\.mp4)', headers: longCache },
      { source: '/posters/:path*', headers: longCache },
    ];
  },
  async redirects() {
    // Legacy numeric product URLs → slug URLs
    return [
      { source: '/product/1', destination: '/product/brightening-cleansing-mask', permanent: true },
      { source: '/product/2', destination: '/product/root-revival-hair-mask-cocktail', permanent: true },
      { source: '/product/3', destination: '/product/root-revival-hair-oil', permanent: true },
      { source: '/product/4', destination: '/product/hair-care-kit', permanent: true },
      { source: '/product/5', destination: '/product/bridal-kit', permanent: true },
    ];
  },
};

export default nextConfig;
