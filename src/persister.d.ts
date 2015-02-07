/// <reference path="../typings/async.d.ts" />

import Identifier = require('./id/identifier');
import Table = require("./core/table");
import ResultCallback = require("./core/resultCallback");
import InternalSession = require("./internalSession");
import PropertyFlags = require("./mapping/propertyFlags");
import Batch = require("./batch");
import ChangeTracking = require("./mapping/changeTracking");
import IdentityGenerator = require("./id/identityGenerator");
import EntityMapping = require("./mapping/entityMapping");
import Result = require("./core/result");
import Callback = require("./core/callback");
import QueryDefinition = require("./query/queryDefinition");

interface Persister {

    changeTracking: ChangeTracking;
    identity: IdentityGenerator;

    dirtyCheck(batch: Batch, entity: Object, originalDocument: Object): Result<any>;
    addInsert(batch: Batch, entity: Object): Result<any>;
    addRemove(batch: Batch, entity: Object): void;

    findOneById(id: Identifier, callback: ResultCallback<any>): void;
    resolve(entity: Object, path: string, callback: Callback): void;
    refresh(entity: Object, callback: ResultCallback<Object>): void;
    executeQuery(query: QueryDefinition, callback: ResultCallback<any>): void;

    findInverseOf(id: Identifier, path: string, callback: ResultCallback<Object[]>): void;
    findOneInverseOf(id: Identifier, path: string, callback: ResultCallback<Object>): void;

}

export = Persister;