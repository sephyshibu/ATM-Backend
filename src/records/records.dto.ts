import { Transform, Type } from "class-transformer"
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator"

// What each Records request may send. Values are tidied and checked further in the services (domains, emails,
// countries, list codes), so the messages people see are specific.

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value)
/** An empty string means "clear this field". */
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === "string" && value.trim() === "" ? null : typeof value === "string" ? value.trim() : value)

export class OrganisationFields {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(1, { message: "Give the organisation a name." })
  @MaxLength(200)
  name?: string

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  domain?: string | null

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(2)
  hqCountry?: string | null

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  linkedinUrl?: string | null

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string

  /** The parent group: another organisation's id; null takes it out of a group. */
  @Transform(emptyToNull)
  @IsOptional()
  @IsUUID()
  parentId?: string | null

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  legalEntity?: string | null

  @IsOptional()
  @IsBoolean()
  excluded?: boolean

  /** Required whenever `excluded` changes: why it was excluded, or why it no longer is. */
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  exclusionReason?: string

  /** Codes from the Tags list; the record's tags become exactly these. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  tagCodes?: string[]
}

/** `name` is required (checked in the service). */
export class CreateOrganisationDto extends OrganisationFields {}

export class UpdateOrganisationDto extends OrganisationFields {}

export class BrandFields {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(1, { message: "Give the brand a name." })
  @MaxLength(200)
  name?: string

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  domain?: string

  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) categoryCode?: string | null
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) subCategoryCode?: string | null
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) routingCode?: string | null
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) tierCode?: string | null
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(2) homeCountry?: string | null

  /** Whole US dollars. */
  @IsOptional()
  @IsInt({ message: "Home revenue: enter a whole number of US dollars." })
  @Min(0)
  @Max(1_000_000_000_000)
  homeRevenueUsd?: number | null

  @IsOptional()
  @IsInt()
  @Min(1990)
  @Max(2100)
  revenueYear?: number | null

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  asianMarketsLive?: string[]

  @Transform(emptyToNull)
  @IsOptional()
  @IsUUID()
  ownerId?: string | null

  @Transform(trim) @IsOptional() @IsString() @MaxLength(5000) description?: string
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(300) linkedinUrl?: string | null

  /** Codes from the Tags list; the record's tags become exactly these. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  tagCodes?: string[]
}

/** `name` and `domain` are required (checked in the service). */
export class CreateBrandDto extends BrandFields {
  /** An existing organisation… */
  @IsOptional()
  @IsUUID()
  organisationId?: string

  /** …or a new one, made with the brand. */
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateOrganisationDto)
  newOrganisation?: CreateOrganisationDto
}

export class UpdateBrandDto extends BrandFields {
  /** Move the brand to another organisation. */
  @IsOptional()
  @IsUUID()
  organisationId?: string
}

export class PersonFields {
  @Transform(trim) @IsOptional() @IsString() @MinLength(1, { message: "Add a first name." }) @MaxLength(100) firstName?: string
  @Transform(trim) @IsOptional() @IsString() @MaxLength(100) lastName?: string
  @Transform(trim) @IsOptional() @IsString() @MaxLength(150) jobTitle?: string
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(254) email?: string | null
  @IsOptional() @IsIn(["unknown", "verified", "invalid"]) emailStatus?: string
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) phone?: string | null
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(300) linkedinUrl?: string | null
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(2) country?: string | null
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) buyingRoleCode?: string | null
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) consentCode?: string | null
  @Transform(trim) @IsOptional() @IsString() @MaxLength(5000) notes?: string
}

/** `firstName` is required (checked in the service). */
/** `firstName` is required (checked in the service). */
export class CreatePersonDto extends PersonFields {
  @IsUUID()
  organisationId!: string

  /** Brands of that organisation to link the person to straight away. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID("all", { each: true })
  brandIds?: string[]
}

export class UpdatePersonDto extends PersonFields {}

export class ProductFields {
  @Transform(trim) @IsOptional() @IsString() @MinLength(1, { message: "Give the product a name." }) @MaxLength(200) name?: string
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(80) sku?: string | null
  /** Empty: the product takes the brand's category and sub-category. */
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) categoryCode?: string | null
  @Transform(emptyToNull) @IsOptional() @IsString() @MaxLength(40) subCategoryCode?: string | null
  @Transform(trim) @IsOptional() @IsString() @MaxLength(5000) description?: string

  /** Codes from the Tags list; the record's tags become exactly these. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  tagCodes?: string[]
}

/** `name` is required (checked in the service). */
export class CreateProductDto extends ProductFields {}

export class UpdateProductDto extends ProductFields {}

export class CreateTagDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: "Give the tag a name." })
  @MaxLength(60)
  label!: string
}

export class LinkPersonDto {
  @IsUUID()
  personId!: string

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean
}

export class ArchiveDto {
  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @MaxLength(40)
  reasonCode?: string | null

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string
}
