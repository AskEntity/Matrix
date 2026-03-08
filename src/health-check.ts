export interface HealthCheckResult {
	status: string;
	uptime: number;
	memoryUsage: NodeJS.MemoryUsage;
}

export function checkHealth(): HealthCheckResult {
	return {
		status: "ok",
		uptime: process.uptime(),
		memoryUsage: process.memoryUsage(),
	};
}
