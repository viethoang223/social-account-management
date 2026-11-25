import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { loadConfig } from '@seedingsys/config';
import { createDb } from '@seedingsys/db';
import { systemClock } from '@seedingsys/domain';
import { AuthGuard } from './auth';
import { ConfigController } from './config.controller';
import { ExtensionController } from './extension.controller';
import { ImportController } from './import.controller';
import { LibraryController } from './library.controller';
import { OpsController } from './ops.controller';
import { PersonasController } from './personas.controller';
import { createStore } from '@seedingsys/storage';
import { CLOCK, CONFIG, DB, STORE } from './tokens';

const cfg = loadConfig();

@Module({
  controllers: [OpsController, ConfigController, ImportController, LibraryController, ExtensionController, PersonasController],
  providers: [
    { provide: CONFIG, useValue: cfg },
    { provide: DB, useValue: createDb(cfg.DATABASE_URL) },
    { provide: CLOCK, useValue: systemClock },
    { provide: STORE, useValue: createStore(cfg) },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
