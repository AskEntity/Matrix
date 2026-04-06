/**
 * Tree tools — get_tree, get_task, create_folder, delete_folder, rename_folder.
 * Read and organize the task tree.
 */

import { z } from "zod";
import type { ToolDef } from "../tool-def.ts";
import * as R from "../resource-registry.ts";
import { isFolder, isTask, stripSession } from "../types.ts";

export const getTreeTool: ToolDef = {
	name: "get_tree",
	description:
		"Get the current task tree. Returns all nodes with their status, branch, and hierarchy.",
	params: {
		projectId: {
			schema: z.string(),
			decl: { kind: "bind", from: "projectId", overridable: false },
		},
		taskId: {
			schema: z.string(),
			decl: { kind: "bind", from: "taskId", overridable: false },
			description: "Used to mark the calling agent's node with (you).",
		},
		format: {
			schema: z.enum(["flat", "tree"]),
			decl: { kind: "optional" },
		},
		include_closed: {
			schema: z.boolean(),
			decl: { kind: "optional" },
			description:
				"Include closed tasks in the result. Default false — closed tasks are hidden to reduce noise.",
		},
		include_details: {
			schema: z.boolean(),
			decl: { kind: "optional" },
			description:
				"Include full details (description, branch, worktreePath, color, costUsd, etc.) for each node. Default false — returns only id, title, status, children, parentId.",
		},
	},
	handler: async (args) => {
		const tracker = R.getTracker(args.projectId as string);
		if (!tracker) {
			return {
				content: [{ type: "text", text: "Project not found" }],
				isError: true,
			};
		}
		const currentTaskId = args.taskId as string | null;

		let nodes = tracker.allNodes();
		if (!args.include_closed) {
			nodes = nodes.filter((n) => isFolder(n) || n.status !== "closed");
		}
		const visibleIds = new Set(nodes.map((n) => n.id));
		const filterChildren = (children: string[]) =>
			children.filter((id) => visibleIds.has(id));

		const result = args.include_details
			? nodes.map((n) => {
					if (isFolder(n)) {
						return { ...n, children: filterChildren(n.children) };
					}
					const rest = stripSession(n);
					const node: Record<string, unknown> = {
						...rest,
						children: filterChildren(rest.children),
						...(rest.id === currentTaskId ? { you: true } : {}),
					};
					return node;
				})
			: nodes.map((n) => {
					const node: Record<string, unknown> = {
						id: n.id,
						title:
							n.title + (n.id === currentTaskId ? " (you)" : ""),
						children: filterChildren(n.children),
						parentId: n.parentId,
					};
					if (isTask(n)) node.status = n.status;
					if (isFolder(n)) node.type = "folder";
					return node;
				});

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ nodes: result }, null, 2),
				},
			],
		};
	},
};

export const getTaskTool: ToolDef = {
	name: "get_task",
	description:
		"Get a single task's full details including description. Use when you need to read a specific task's description or other detailed fields.",
	params: {
		projectId: {
			schema: z.string(),
			decl: { kind: "bind", from: "projectId", overridable: false },
		},
		taskId: {
			schema: z.string().describe("Task node ID (or unique prefix, min 8 chars)"),
			decl: { kind: "explicit" },
		},
	},
	handler: async (args) => {
		const tracker = R.getTracker(args.projectId as string);
		if (!tracker) {
			return {
				content: [{ type: "text", text: "Project not found" }],
				isError: true,
			};
		}
		const node = tracker.getTask(args.taskId as string);
		if (!node) {
			return {
				content: [
					{
						type: "text",
						text: `Task not found: ${args.taskId}`,
					},
				],
				isError: true,
			};
		}
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(stripSession(node), null, 2),
				},
			],
		};
	},
};

export const createFolderTool: ToolDef = {
	name: "create_folder",
	description:
		"Create a folder for visual grouping. Folders have no status, no lifecycle — pure organization. Tasks inside folders are logically owned by the nearest task ancestor above the folder.",
	params: {
		projectId: {
			schema: z.string(),
			decl: { kind: "bind", from: "projectId", overridable: false },
		},
		parentId: {
			schema: z.string(),
			decl: { kind: "bind", from: "taskId", overridable: true },
			description:
				"Parent node ID. Omit to create under your current task.",
		},
		title: {
			schema: z.string().describe("Folder title"),
			decl: { kind: "explicit" },
		},
	},
	handler: async (args) => {
		const tracker = R.getTracker(args.projectId as string);
		if (!tracker) {
			return {
				content: [{ type: "text", text: "Project not found" }],
				isError: true,
			};
		}
		const parentId = args.parentId as string;
		const parent = tracker.get(parentId);
		if (!parent) {
			return {
				content: [
					{
						type: "text",
						text: `Parent node not found: ${parentId}`,
					},
				],
				isError: true,
			};
		}
		const folder = tracker.addFolder(args.title as string, parentId);
		tracker.save();
		R.broadcastTree(args.projectId as string);
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(folder, null, 2),
				},
			],
		};
	},
};

export const deleteFolderTool: ToolDef = {
	name: "delete_folder",
	description:
		"Delete an empty folder. Fails if the folder has children — move or delete them first.",
	params: {
		projectId: {
			schema: z.string(),
			decl: { kind: "bind", from: "projectId", overridable: false },
		},
		folderId: {
			schema: z
				.string()
				.describe("ID of the folder to delete"),
			decl: { kind: "explicit" },
		},
	},
	handler: async (args) => {
		const tracker = R.getTracker(args.projectId as string);
		if (!tracker) {
			return {
				content: [{ type: "text", text: "Project not found" }],
				isError: true,
			};
		}
		const node = tracker.get(args.folderId as string);
		if (!node) {
			return {
				content: [
					{
						type: "text",
						text: `Node not found: ${args.folderId}`,
					},
				],
				isError: true,
			};
		}
		if (!isFolder(node)) {
			return {
				content: [
					{
						type: "text",
						text: `${args.folderId} is not a folder.`,
					},
				],
				isError: true,
			};
		}
		if (node.children.length > 0) {
			return {
				content: [
					{
						type: "text",
						text: `Folder "${node.title}" has ${node.children.length} children. Move or delete them first.`,
					},
				],
				isError: true,
			};
		}
		tracker.remove(args.folderId as string);
		tracker.save();
		R.broadcastTree(args.projectId as string);
		return {
			content: [
				{
					type: "text",
					text: `Folder "${node.title}" deleted.`,
				},
			],
		};
	},
};

export const renameFolderTool: ToolDef = {
	name: "rename_folder",
	description: "Rename a folder.",
	params: {
		projectId: {
			schema: z.string(),
			decl: { kind: "bind", from: "projectId", overridable: false },
		},
		folderId: {
			schema: z
				.string()
				.describe("ID of the folder to rename"),
			decl: { kind: "explicit" },
		},
		title: {
			schema: z.string().describe("New title for the folder"),
			decl: { kind: "explicit" },
		},
	},
	handler: async (args) => {
		const tracker = R.getTracker(args.projectId as string);
		if (!tracker) {
			return {
				content: [{ type: "text", text: "Project not found" }],
				isError: true,
			};
		}
		const node = tracker.get(args.folderId as string);
		if (!node) {
			return {
				content: [
					{
						type: "text",
						text: `Node not found: ${args.folderId}`,
					},
				],
				isError: true,
			};
		}
		if (!isFolder(node)) {
			return {
				content: [
					{
						type: "text",
						text: `${args.folderId} is not a folder.`,
					},
				],
				isError: true,
			};
		}
		tracker.updateTitle(args.folderId as string, args.title as string);
		tracker.save();
		R.broadcastTree(args.projectId as string);
		return {
			content: [
				{
					type: "text",
					text: `Folder renamed to "${args.title}".`,
				},
			],
		};
	},
};
