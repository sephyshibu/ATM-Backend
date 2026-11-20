import { Global, Injectable, Logger, Module, OnApplicationBootstrap } from "@nestjs/common"

import { hardenDatabase, syncPermissionCatalogue } from "./db-hardening"
import { PrismaService } from "./prisma.service"

@Injectable()
class DbStartup implements OnApplicationBootstrap {
  private readonly log = new Logger("Database")
  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    await hardenDatabase(this.prisma)
    await syncPermissionCatalogue(this.prisma)
    this.log.log("Change log is append-only; permission catalogue is up to date.")
  }
}

@Global()
@Module({
  providers: [PrismaService, DbStartup],
  exports: [PrismaService],
})
export class PrismaModule {}
