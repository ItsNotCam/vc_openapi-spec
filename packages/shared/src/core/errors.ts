export class ApiError extends Error {
	code: number;
	constructor(message: string, code: number) {
		super(message);
		this.name = "ApiError";
		this.code = code;
	}
}

export class SpecNotFoundError extends ApiError {
	constructor(api: string) {
		super(`API '${api}' not found`, 404);
		this.name = "SpecNotFoundError";
	}
}

export class SpecLoadError extends ApiError {
	constructor(source: string, reason?: string) {
		super(`Failed to load spec from '${source}'${reason ? `: ${reason}` : ""}`, 400);
		this.name = "SpecLoadError";
	}
}

export class StoreError extends ApiError {
	constructor(message: string) {
		super(message, 500);
		this.name = "StoreError";
	}
}

export class AuthError extends ApiError {
	constructor(message: string = "Unauthorized") {
		super(message, 401);
		this.name = "AuthError";
	}
}

export class ForbiddenError extends ApiError {
	constructor(message: string = "Forbidden") {
		super(message, 403);
		this.name = "ForbiddenError";
	}
}
