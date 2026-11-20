import { Transform } from "class-transformer"
import { ArrayMaxSize, IsArray, IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator"

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value)

export class InviteUserDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: "Add a valid email." })
  email!: string

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: "Add their name." })
  @MaxLength(120)
  name!: string

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string

  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID("all", { each: true })
  roleIds!: string[]
}

export class UpdateUserDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(1, { message: "Add their name." })
  @MaxLength(120)
  name?: string

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID("all", { each: true })
  roleIds?: string[]
}

export class ReasonDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string
}
