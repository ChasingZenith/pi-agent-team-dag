import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/** Frontend for the tasks-server (server/). /api is proxied to it, so
 *  the browser only ever talks to the vite dev server (front/back separated). */
export default defineConfig({
	plugins: [svelte()],
	server: {
		host: "127.0.0.1",
		port: 5173,
		proxy: {
			"/api": "http://127.0.0.1:8787",
		},
	},
});
