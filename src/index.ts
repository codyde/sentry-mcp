import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Props } from "./types";
import { z } from "zod";
import app from "./app";
import { SentryEventSchema, SentryIssueSchema } from "./schema";

const API_BASE_URL = "https://sentry.io/api/0";

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
export class SentryMCP extends McpAgent<Props, Env> {
	server = new McpServer({
		name: "Sentry MCP",
		version: "1.0.0",
	});

	async init() {
		// Hello, world!
		this.server.tool("echo", "Echo a message", { message: z.string() }, async ({ message }) => ({
			content: [{ type: "text", text: message }],
		}));

		this.server.tool(
			"search_errors_in_file",
			"Search Sentry for errors occurring in a specific file. A maximum of 3 results will be returned.",
			{
				filename: z.string().describe("The path or name of the file to search for errors in"),
			},
			async ({
				filename,
			}: {
				filename: string;
			}) => {
				try {
					// Construct the query based on identifier type
					const query = `stack.filename:"*/${filename}" status:unresolved`;
					const limit = 3;

					// const organization_slug = this.props.organizationSlug;
					const organization_slug = "sentry"; // TODO: move this to onboarding

					// Construct the URL for the Sentry API
					const apiUrl: string = `${API_BASE_URL}/projects/${organization_slug}/issues/?query=${encodeURIComponent(query)}&collapse=stats&collapse=lifetime&collapse=base&collapse=filtered&limit=${limit}`;

					// Make the API request
					const response = await fetch(apiUrl, {
						method: "GET",
						headers: {
							Authorization: `Bearer ${this.props.accessToken}`,
							"Content-Type": "application/json",
						},
					});

					// Check if the request was successful
					if (!response.ok) {
						const errorText: string = await response.text();
						console.error("DEBUG: API request failed:", response.status, errorText);
						return {
							content: [
								{
									type: "text",
									text: `Failed to search for errors: ${response.status} ${response.statusText}\n${errorText}`,
								},
							],
							isError: true,
						};
					}

					// Parse the response
					const issues: z.infer<typeof SentryIssueSchema>[] = (
						await response.json<unknown[]>()
					).map((i) => SentryIssueSchema.parse(i));

					// Format the output based on the view type and format
					let output = "";

					if (issues.length === 0) {
						output = `# No issues found\nCould not find any errors for file \`${filename}\` in project \`${project_slug}\`.`;

						return {
							content: [{ type: "text", text: output }],
						};
					}

					output = `# Errors in \`${filename}\`\n\n`;

					for (const issue of issues) {
						output += `## ${issue.shortId}: ${issue.title}\n`;
						output += `- **ID**: ${issue.shortId}\n`;
						output += `- **Last Seen**: ${issue.lastSeen}\n`;
						output += `- **Occurences**: ${issue.count}\n`;
						output += `- **Link**: [View in Sentry](${issue.permalink})\n\n`;

						// CRINGE
						const eventResponse = await fetch(
							`${API_BASE_URL}/projects/${organization_slug}/issues/${issue.id}/events/latest/`,
							{
								method: "GET",
								headers: {
									Authorization: `Bearer ${this.props.accessToken}`,
									"Content-Type": "application/json",
								},
							},
						);
						const event = SentryEventSchema.parse(await eventResponse.json());
						for (const entry of event.entries) {
							if (entry.type === "exception") {
								const firstError = entry.data.values[0];
								output += `Error:\n${"```"}\n${firstError.type}: ${firstError.value}\n${"```"}\n\n`;
								output += `Stacktrace:\n${"```"}\n${firstError.stacktrace.frames
									.map(
										(frame) =>
											`${frame.filename} (line ${frame.lineno})\n${frame.context
												.filter(([lineno, _]) => lineno === frame.lineno)
												.map(([_, code]) => `${code}`)
												.join("\n")}`,
									)
									.join("\n")}\n${"```"}\n\n`;
							}
						}
					}

					output = `# Using this information\n\nYou can reference the ID in commit messages (e.g. \`Fixes #${issue.shortId}\`) to automatically close the issue when the commit is merged.`;

					return {
						content: [
							{
								type: "text",
								text: output,
							},
						],
					};
				} catch (error: any) {
					console.error("DEBUG: Caught error:", error);
					return {
						content: [
							{
								type: "text",
								text: `Error searching for file errors: ${error.message}`,
							},
						],
						isError: true,
					};
				}
			},
		);
	}
}

export default new OAuthProvider({
	apiRoute: "/sse",
	// @ts-ignore
	apiHandler: SentryMCP.mount("/sse"),
	// @ts-ignore
	defaultHandler: app,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});
