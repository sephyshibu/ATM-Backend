import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common"

// Errors carry a sentence the screen can show as it is.

export const badRequest = (message: string) => new BadRequestException(message)
export const conflict = (message: string) => new ConflictException(message)
export const forbidden = (message: string) => new ForbiddenException(message)
export const notFound = (what: string) => new NotFoundException(`${what} wasn't found.`)
