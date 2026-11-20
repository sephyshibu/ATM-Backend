import { Transform } from "class-transformer"
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from "class-validator"

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value)

export class CreateRoleDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: "Give the role a name." })
  @MaxLength(60)
  name!: string

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string

  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissionKeys!: string[]
}

export class UpdateRoleDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(1, { message: "Give the role a name." })
  @MaxLength(60)
  name?: string

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissionKeys?: string[]
}
