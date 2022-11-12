import * as async from "async";
import {EventEmitter} from "events";
import {Callback} from "./core/callback";
import {ChangeTrackingType} from "./mapping/mappingModel";
import {Constructor} from "./index";
import {MappingModel} from "./mapping/mappingModel";
import {ResultCallback} from "./core/callback";
import {InternalSessionFactory, SessionFactory} from "./sessionFactory";
import {TaskQueue} from "./taskQueue";
import {DirtyCheckContext, Persister} from "./persister";
import {Batch} from "./batch";
import {Reference} from "./reference";
import {Table} from "./core/table";
import {EntityMapping} from "./mapping/entityMapping";
import {QueryBuilder, QueryBuilderImpl, FindOneQuery} from "./query/queryBuilder";
import {QueryDefinition} from "./query/queryDefinition";
import {Observer} from "./observer";
import {PersistenceError} from "./persistenceError";
import {WriteContext} from "./mapping/writeContext";
import {getDuration} from "./core/timerUtil";

/**
 * The state of an object.
 */
const enum ObjectState {

    /**
     * Managed entities have a persistent identity and are associated with a session.
     */
    Managed,

    /**
     * Detached entities have a persistent identity and are not currently associated with a session.
     */
    Detached,

    /**
     * Removed entities have a persistent identity, are associated with a session, and are scheduled for deletion
     * from the database. Once the entity is deleted from the database, the entity is no longer managed and is
     * considered a new entity.
     */
    Removed
}

const enum ObjectFlags {

    None        = 0,
    ReadOnly    = 0x00000001,
    Dirty       = 0x00000002,
    Observing   = 0x00000004
}

const enum ScheduledOperation {

    None = 0,
    Insert,
    Update,
    Delete,
    DirtyCheck
}

const enum Action {

    Save        = 0x00000001,
    Remove      = 0x00000002,
    Detach      = 0x00000004,
    Flush       = 0x00000008,
    Clear       = 0x00000010,
    Refresh     = 0x00000020,
    Merge       = 0x00000040,
    Fetch       = 0x00000080,
    FindQuery   = 0x00000100,
    ModifyQuery = 0x00000200,
    Wait        = 0x00000400,
    Close       = 0x00000800,

    ReadOnly = Fetch | FindQuery,
    All = Save | Remove | Detach | Flush | Clear | Refresh | Merge | Fetch | FindQuery | ModifyQuery | Wait | Close
}

interface ObjectLinks {

    state: ObjectState;
    flags: ObjectFlags;
    object?: any;
    originalDocument?: any;
    persister?: Persister;
    scheduledOperation?: ScheduledOperation;
    next?: ObjectLinks;
    prev?: ObjectLinks;
    index?: number;
    observer?: Observer;
}

/**
 * Static ObjectLinks returned from getObjectLinks for detached objects. There is no need to create a new ObjectLinks
 * object for each detached object.
 */
var cachedDetachedLinks: ObjectLinks = {
    state: ObjectState.Detached,
    flags: ObjectFlags.None
};


/**
 *  The primary interface used to interact with the database. The Session is a
 *  [Unit of Work](http://martinfowler.com/eaaCatalog/unitOfWork.html) that keeps track of changes until they are
 *  synchronized with the database by calling [[flush]] or [[close]].
 */
export interface Session {

    /**
     * The [SessionFactory] that created this [Session].
     */
    factory: SessionFactory;

    /**
     * Saves an entity to the Session. If the entity is new then it becomes managed. If the entity is already managed
     * then it is flagged for dirty check. The entity is not actually saved to the database until the Session is
     * flushed.
     * @param obj The entity to save.
     * @param callback Called after the entity has been added to the Session.
     */
    save(obj: Object, callback?: Callback): void;

    /**
     * Removes an entity from the Session. The entity is not actually removed from the database util the Session is
     * flushed.
     * @param obj The entity to remove.
     * @param callback Called after the entity has been removed from the Session.
     */
    remove(obj: Object, callback?: Callback): void;

    /**
     * Detaches an entity from the Session making it unmanaged. Any changes to the entity will not be persisted.
     * @param obj The entity to detach.
     * @param callback Called after the entity has been detached.
     */
    detach(obj: Object, callback?: Callback): void;

    /**
     * Refreshes an entity state from database. Any changes to the entity are discarded.
     * @param obj The entity to refresh.
     * @param callback Called after the entity has been refreshed.
     */
    refresh(obj: Object, callback: Callback): void;

    /**
     * Synchronizes the Session with the database, writing any changes.
     * @param callback Called after the changes have been written to the database.
     */
    flush(callback?: Callback): void;

    /**
     * Clears the Session, detaching all managed entities.
     * @param callback Called after the Session has been cleared.
     */
    clear(callback?: Callback): void;

    /**
     * Finds an entity by identifier.
     * @param ctr The constructor for the entity to find.
     * @param id The identifier for the entity.
     * @param callback Called with the entity.
     */
    find<T>(ctr: Constructor<T>, id: any, callback?: ResultCallback<T>): FindOneQuery<T>;

    /**
     * Check by identifier if an entity exists.
     * @param ctr The constructor for the entity to find.
     * @param id The identifier for the entity.
     * @param callback Called with a boolean indicating if an entity with exists or not. Note that if an entity is pending removal then the
     * value will be false.
     */
    exists<T>(ctr: Constructor<T>, id: any, callback: ResultCallback<boolean>): void;

    /**
     * Gets a reference to an entity without making a request to the database.
     * @param ctr The constructor for the entity.
     * @param id The identifier for the entity.
     */
    getReference<T>(ctr: Constructor<T>, id: any): T;

    /**
     * Fetches an entity reference from the database.
     * @param obj The entity reference to fetch.
     * @param callback Called with the fetched entity.
     */
    fetch<T>(obj: T, callback?: ResultCallback<T>): void;

    /**
     * Fetches entity references at the specified path(s) on the given entity.
     * @param obj The entity
     * @param path The path(s) to check. Uses the same
     * [dot notation](https://docs.mongodb.org/manual/core/document/#dot-notation) that MongoDB uses for queries.
     * @param callback Called after any entity references have been fetched.
     */
    fetch<T>(obj: T, path: string | string[], callback?: ResultCallback<T>): void;

    query<T>(ctr: Constructor<T>): QueryBuilder<T>;

    /**
     * Waits for pending operations on the Session to complete.
     * @param callback Called after all pending operations on the Session have completed.
     */
    wait(callback?: Callback): void;

    /**
     * Flushes any changes to the database and closes the Session. Calling operations on a closed Session will result
     * in an error.
     * @param callback Called after the Session has been closed.
     */
    close(callback?: Callback): void;

    /**
     * Checks if an entity is contained in the Session.
     * @param obj The entity to check.
     */
    contains(obj: Object): boolean;

    /**
     * Converts an entity to a document, the same document that is stored in the database. The document is suitable for serialization to
     * JSON.
     * @param obj The entity to convert to a document.
     * @param callback Optional callback is called with serialized document. If callback is provided, any errors encountered during
     * writing the document are passed to the callback. If a callback is not provided and errors are encountered during writing the
     * document, `null` is returned.
     */
    toDocument(obj: Object, callback?: ResultCallback<Object>): Object;

    /**
     * Checks if an entity has changed since it was loaded from the database.
     * @param obj The entity to check.
     * @param callback Optional callback is called with a boolean indicating if the entity has changed. If callback is provided, any errors
     * encountered during checking the entity are passed to the callback. If a callback is not provided and errors are encountered during
     * checking the entity, `null` is returned.
     */
    isDirty(obj: Object, callback?: ResultCallback<boolean>): boolean;

    /**
     * Gets the version number of an entity. Returns `null` if the version cannot be determined.
     * @param obj The entity to get the version for.
     */
    getVersion(obj: Object): number;

    /**
     * Gets an array of all entities managed by the session.
     */
    getEntities(): Object[];

    /**
     * Adds an event listener.
     * @param event The event to listen for.
     * @param listener The listener function.
     */
    on(event: string, listener: Function): EventEmitter;
}

/**
 * @hidden
 */
export interface InternalSession extends Session {

    factory: InternalSessionFactory;

    getObject(id: any): any;
    registerManaged(persister: Persister, entity: Object, document: any): void;
    notifyRemoved(entity: Object): void;
    getPersister(mapping: EntityMapping): Persister;
    getReferenceInternal(mapping: EntityMapping, id: any): any;
    fetchInternal(entity: Object, paths: string[], callback: ResultCallback<any>): void;
    executeQuery(query: QueryDefinition, callback: ResultCallback<any>): void;
}

// TODO: review all errors and decide if they are operational or programmer errors. For example, what about mapping errors?
// TODO: decide where it makes sense to use WeakMap, Promise, Set, WeakSet which is now a native part of Node 12
// TODO: raise events on UnitOfWork
/**
 * @hidden
 */
export class SessionImpl extends EventEmitter implements InternalSession {

    /**
     * Cached Persisters by Mapping
     */
    private _persisters: Table<Persister> = [];

    /**
     * Hash table containing all objects by id associated with the session.
     */
    private _objectLinksById: Map<string, ObjectLinks> = new Map();

    /**
     * List of all ObjectLinks associated with the session.
     */
    private _objectLinks: ObjectLinks[] = [];

    /**
     * Scheduled operations linked list head.
     */
    private _scheduleHead: ObjectLinks;

    /**
     * Scheduled operations linked list tail.
     */
    private _scheduleTail: ObjectLinks;

    /**
     * Task queue coordinates asynchronous actions.
     */
    private _queue: TaskQueue;

    private readonly _traceEnabled: boolean;

    constructor(public factory: InternalSessionFactory) {
        super();

        this._createTaskQueue();
        this._traceEnabled = this.factory.logger != null;
    }

    save(obj: any, callback?: Callback): void {
        if (typeof obj !== "object") {
            throw new Error("'obj' argument should be an object.");
        }

        this._queue.add(Action.Save, Action.All & ~(Action.Save | Action.ReadOnly), obj, callback);
    }

    remove(obj: any, callback?: Callback): void {
        if (typeof obj !== "object") {
            throw new Error("'obj' argument should be an object.");
        }

        this._queue.add(Action.Remove, Action.All & ~Action.Remove, obj, callback);
    }

    refresh(obj: any, callback?: Callback): void {
        if (typeof obj !== "object") {
            throw new Error("'obj' argument should be an object.");
        }

        this._queue.add(Action.Refresh, Action.All & ~Action.Refresh, obj, callback);
    }

    detach(obj: any, callback?: Callback): void {
        if (typeof obj !== "object") {
            throw new Error("'obj' argument should be an object.");
        }

        this._queue.add(Action.Detach, Action.All & ~Action.Detach, obj, callback);
    }

    clear(callback?: Callback): void {

        // check to see if the task queue is invalid. if it is, create a new one. the session becomes invalid when an error occurs since
        // the session may be in an inconsistent state with the database. however, clearing the session means that it has no state so it
        // should make the session valid again. we do this by creating a new task queue.
        if (this._queue.invalid) {
            this._createTaskQueue();
        }
        this._queue.add(Action.Clear, Action.All, undefined, callback);
    }

    flush(callback?: Callback): void {

        this._queue.add(Action.Flush, Action.All, undefined, callback);
    }

    wait(callback?: Callback): void {

        this._queue.add(Action.Wait, Action.All, undefined, callback);
    }

    find<T>(ctr: Constructor<T>, id: any, callback?: ResultCallback<T>): FindOneQuery<T> {

        return this.query(ctr).findOneById(id, callback);
    }

    exists<T>(ctr: Constructor<T>, id: any, callback: ResultCallback<boolean>): void {

        // check the identity map for the identifier
        var obj = this.getObject(id);

        // if we get an object back then entity is managed
        if (obj) {
            process.nextTick(() => callback(null, true));
            return;
        }

        // if null then entity is pending removal
        if (obj === null) {
            process.nextTick(() => callback(null, false));
            return;
        }

        // otherwise, check the database
        this.query(ctr).count({ _id: id }, (err, count) => {
            if (err) return callback(err);

            callback(null, count >= 1);
        });
    }

    fetch<T>(obj: T, pathsOrCallback: any, callback?: ResultCallback<T>): void {

        var paths: string[];

        if(typeof pathsOrCallback === "function") {
            callback = pathsOrCallback;
        }
        else if(typeof pathsOrCallback === "string") {
            paths = [pathsOrCallback];
        }
        else {
            paths = pathsOrCallback;
        }

        this._queue.add(Action.Fetch, Action.All & ~Action.ReadOnly, [obj, paths], callback);
    }

    close(callback?: Callback): void {

        this._queue.add(Action.Close, Action.All, undefined, callback);
    }

    executeQuery(query: QueryDefinition, callback: ResultCallback<any>): void {

        if(query.readOnly) {
            this._queue.add(Action.FindQuery, Action.All & ~Action.ReadOnly, query, callback);
        }
        else {
            this._queue.add(Action.ModifyQuery, Action.All, query, callback);
        }
    }

    /**
     * Determines whether an entity is managed by this session.
     * @param obj The entity to check.
     */
    contains(obj: any): boolean {
        if (typeof obj !== "object") {
            throw new Error("'obj' argument should be an object.");
        }

        var id = obj["id"];
        if(id) {
            var links = this._objectLinksById.get(id);
            if(links && links.state == ObjectState.Managed) {
                return true;
            }
        }

        return false;
    }

    /**
     * Gets an array of all entities managed by the session.
     */
    getEntities(): Object[] {

        var ret = new Array(this._objectLinksById.size),
            i = 0;

        this._objectLinksById.forEach((value) => {
            ret[i++] = value.object;
        });

        return ret;
    }

    /**
     * Get an instance whose state may be fetched in the future.
     * @param ctr The constructor
     * @param id The id of the entity
     * @param callback Called with the reference.
     */
    getReference<T>(ctr: Constructor<T>, id: any): T {

        var mapping = this.factory.getMappingForConstructor(ctr);
        if(mapping) {
            // validate the id that was passed in now instead of when reference is resolved so we save time on references
            // that were already validated by the mapping
            var identityGenerator = (<EntityMapping>mapping.inheritanceRoot).identity;
            if (typeof id === "string") {
                id = identityGenerator.fromString(id);
            }
            else {
                if (!identityGenerator.validate(id)) {
                    // If the id is invalid, clear it out. An error will be returned when the reference is fetched
                    id = null;
                }
            }
        }

        // If the mapping is not found, the reference is still created. An error will be returned when the reference
        // is fetched.
        return this.getReferenceInternal(mapping, id);
    }


    /**
     * Converts an entity to a document, the same document that is stored in the database. The document is suitable for serialization to
     * JSON.
     * @param obj The entity to convert to a document.
     * @param callback Optional callback is called with serialized document. If callback is provided, any errors encountered during
     * writing the document are passed to the callback. If a callback is not provided and errors are encountered during writing the
     * document, `null` is returned.
     */
    toDocument(obj: Object, callback?: ResultCallback<Object>): Object {
        if (typeof obj !== "object") {
            throw new Error("'obj' argument should be an object.");
        }

        var mapping = this.factory.getMappingForObject(obj);
        if (!mapping) {
            if (callback) {
                callback(new PersistenceError("Object type is not mapped as an entity."));
            }
            return null;
        }

        var context = new WriteContext();
        var document = mapping.write(context, obj);
        if(context.hasErrors) {
            if (callback) {
                callback(new PersistenceError(`Error serializing document:\n${context.getErrorMessage()}`));
            }
            return null;
        }

        if (callback) {
            callback(null, document);
        }
        return document;
    }

    isDirty(obj: Object, callback?: ResultCallback<boolean>): boolean {

        if (typeof obj !== "object") {
            throw new Error("'obj' argument should be an object.");
        }

        var links = this._getObjectLinks(obj);
        if (!links || links.state == ObjectState.Detached) {
            if (callback) {
                callback(new PersistenceError("Object is not managed."));
            }
            return null;
        }

        if (!links.originalDocument) {
            // entity has never been saved to the database, so it can't be dirty.
            if (callback) {
                process.nextTick(() => callback(null, false));
            }

            return false;
        }

        var context: DirtyCheckContext = {},
            areEqual = links.persister.areDocumentsEqual(context, obj, links.originalDocument);

        if (context.error) {
            if (callback) {
                callback(context.error);
            }
            return null;
        }

        if (callback) {
            process.nextTick(() => callback(null, !areEqual));
        }

        return !areEqual;
    }

    /**
     * Gets the version number of an entity used for optimistic locking. Returns `null` if the version cannot be determined.
     * @param obj The entity to get the version for.
     */
    getVersion(obj: Object): number {
        if (typeof obj !== "object") {
            throw new Error("'obj' argument should be an object.");
        }

        var links = this._getObjectLinks(obj);
        if (!links || links.state == ObjectState.Detached) {
            return null;
        }

        // return 0 if document has never been saved
        if (!links.originalDocument) {
            return 0;
        }

        var mapping = this.factory.getMappingForObject(obj);
        if (!mapping) {
            return null;
        }

        return mapping.getDocumentVersion(links.originalDocument);
    }

    getReferenceInternal(mapping: EntityMapping, id: any): any {

        // TODO: should we cache references so all references with the same id share the same object?
        return this.getObject(id) || new Reference(mapping, id);
    }

    /**
     * Gets a managed object by the specified id. If the object is found but scheduled for delete then null is
     * returned. If the object is not found then undefined is returned; otherwise, the object is returned.
     * @param id The object identifier.
     */
    getObject(id: any): any {

        if (id) {
            var links = this._objectLinksById.get(id.toString());
            if (links) {
                switch (links.state) {
                    case ObjectState.Removed:
                        return null;
                    case ObjectState.Managed:
                        return links.object
                }
            }
        }

        // otherwise, return undefined
    }

    registerManaged(persister: Persister, entity: any, document: any): void {

        // save the original document for dirty checking
        var links = this._linkObject(entity, persister);
        links.originalDocument = document;
        this._trackChanges(links);
    }

    private _trackChanges(links: ObjectLinks): void {

        if ((links.flags & ObjectFlags.Dirty) || links.persister.changeTracking == ChangeTrackingType.DeferredImplicit) {
            this._makeDirty(links);
            return;
        }
    }

    private static _stopWatching(links: ObjectLinks): void {

        if(links.observer) {
            links.observer.destroy();
            links.observer = undefined;
        }
    }

    getPersister(mapping: EntityMapping): Persister {

        return this._persisters[mapping.id]
            || (this._persisters[mapping.id] = this.factory.createPersister(this, mapping));
    }

    query<T>(ctr: Constructor<T>): QueryBuilder<T> {

        return new QueryBuilderImpl<T>(this, ctr);
    }

    /**
     * Called by TaskQueue to execute an operation.
     * @param action The action to execute.
     * @param arg Contains arguments for the action.
     * @param callback Called when method completes.
     */
    private _execute(action: Action, arg: any, callback: ResultCallback<any>): void {

        switch(action) {
            case Action.Save:
                this._save(arg, callback);
                break;
            case Action.Remove:
                this._remove(arg, callback);
                break;
            case Action.Detach:
                this._detach(arg, callback);
                break;
            case Action.Refresh:
                this._refresh(arg, callback);
                break;
            case Action.Clear:
                this._clear(callback);
                break;
            case Action.Flush:
                this._flush(callback);
                break;
            case Action.Wait:
                if(callback) {
                    process.nextTick(() => callback(null));
                }
                break;
            case Action.Fetch:
                this.fetchInternal(arg[0], arg[1], callback);
                break;
            case Action.FindQuery:
            case Action.ModifyQuery:
                (<QueryDefinition>arg).executeInternal(callback);
                break;
            case Action.Close:
                this._close(callback);
                break;
        }
    }

    private _save(obj: any, callback: Callback): void {

        if(Reference.isReference(obj)) {
            return callback(new PersistenceError("Reference passed to save"));
        }

        this._findReferencedEntities(obj, MappingModel.PropertyFlags.CascadeSave, (err, entities) => {
            if(err) return callback(err);
            this._saveEntities(entities, callback);
        });
    }

    private _saveEntities(entities: any[], callback: Callback): void {

        // Note that if you decide to make this async so you can make identity.genereate async, then you need to make
        // sure to check for the object links a second time before create a new links object incase save is called twice

        for(var i = 0, l = entities.length; i < l; i++) {
            var obj = entities[i];
            var links = this._getObjectLinks(obj);
            if (!links) {
                var mapping = this.factory.getMappingForObject(obj);
                if (!mapping) {
                    callback(new PersistenceError("Object type is not mapped as an entity."));
                    return;
                }

                var persister = this.getPersister(mapping);

                // we haven't seen this object before
                var id = obj["_id"] = persister.identity.generate();
                obj["id"] = id.toString();

                links = this._linkObject(obj, persister);
                this._scheduleOperation(links, ScheduledOperation.Insert);
            }
            else {
                switch (links.state) {
                    case ObjectState.Managed:
                        if (links.persister.changeTracking == ChangeTrackingType.DeferredExplicit) {
                            this._makeDirty(links);
                        }
                        break;
                    case ObjectState.Detached:
                        callback(new PersistenceError("Cannot save a detached object."));
                        return;
                    case ObjectState.Removed:
                        if (links.scheduledOperation == ScheduledOperation.Delete) {
                            // if object is schedule for delete then cancel the pending delete operation.
                            this._clearScheduledOperation(links);
                            this._trackChanges(links);
                        }
                        else {
                            // otherwise, this means the entity has already been removed from the database so queue
                            // object for insert operation.
                            this._scheduleOperation(links, ScheduledOperation.Insert);
                        }

                        links.state = ObjectState.Managed;
                        break;
                }
            }
        }

        // ok with not being async b/c only called in _save above which will be async
        callback();
    }

    private _makeDirty(links: ObjectLinks): void {

        // still flag the object as dirty even if we aren't going to schedule a dirty check because
        // the current operation could be canceled (e.g. save called after remove before flush),
        // and we'll want to queue the object for dirty check at that point.
        links.flags |= ObjectFlags.Dirty;
        if(!links.scheduledOperation) {
            this._scheduleOperation(links, ScheduledOperation.DirtyCheck);
        }
    }

    private _clearDirty(links: ObjectLinks): void {

        // clear dirty flag
        links.flags &= ~ObjectFlags.Dirty;
        // clear scheduled operation if object is scheduled for dirty check
        if(links.scheduledOperation == ScheduledOperation.DirtyCheck) {
            this._clearScheduledOperation(links);
        }
    }

    /**
     * Notifies session that a managed entity has been removed from the database from outside of the session.
     * @param entity The entity that was removed.
     */
    notifyRemoved(entity: Object): void {

        // Remove entity. No need to schedule delete operation since it is already removed from the database.
        if(!this._removeEntity(entity, /* scheduleDelete */ false)) {
            // this should never happen
            throw new PersistenceError("Cannot remove a detached object.");
        }
    }

    private _remove(obj: any, callback: Callback): void {

        // Remove will accept references
        Reference.fetch(this, obj, (err, entity) => {
            if(err) return callback(err);

            this._findReferencedEntities(entity, MappingModel.PropertyFlags.CascadeRemove | MappingModel.PropertyFlags.Dereference, (err, entities) => {
                if (err) return callback(err);
                this._removeEntities(entities, callback);
            });
        });
    }

    private _removeEntities(entities: any[], callback: Callback): void {

        // remove in reverse order
        for(var i = entities.length - 1; i >= 0; i--) {
            var obj = entities[i];

            if(!this._removeEntity(obj, /* scheduleDelete */ true)) {
                callback(new PersistenceError("Cannot remove a detached object."));
                return;
            }
        }

        // ok with not being async b/c only called in _remove above which will be async
        callback();
    }

    private _removeEntity(obj: any, scheduleDelete: boolean): boolean {

        var links = this._getObjectLinks(obj);
        if (links) {
            switch (links.state) {
                case ObjectState.Managed:
                    // set state as removed, object wil be unlinked after flush.
                    links.state = ObjectState.Removed;

                    if (links.scheduledOperation == ScheduledOperation.Insert) {
                        // if the object has never been persisted then clear the insert operation and unlink it
                        this._unlinkObject(links);
                        this._clearScheduledOperation(links);
                    }
                    else {
                        // otherwise, queue object for delete operation
                        if(scheduleDelete) {
                            this._scheduleOperation(links, ScheduledOperation.Delete);
                        }
                    }
                    break;
                case ObjectState.Detached:
                    return false;
            }
        }

        return true;
    }

    private _detach(obj: any, callback: Callback): void {

        if(Reference.isReference(obj)) {
            return callback(new PersistenceError("Reference passed to detach"));
        }

        this._findReferencedEntities(obj, MappingModel.PropertyFlags.CascadeDetach, (err, entities) => {
            if(err) return callback(err);
            this._detachEntities(entities, callback);
        });
    }

    private _detachEntities(entities: any[], callback: Callback): void {

        for(var i = 0, l = entities.length; i < l; i++) {
            var links = this._getObjectLinks(entities[i]);
            if (links && links.state == ObjectState.Managed) {
                this._unlinkObject(links);
                this._clearScheduledOperation(links);
            }
            // TODO: double check how we want to handle Removed entities here.
        }

        // ok with not being async b/c only called in _detach above which will be async
        callback();
    }

    private _refresh(obj: any, callback: Callback): void {

        if(Reference.isReference(obj)) {
            return callback(new PersistenceError("Reference passed to refresh"));
        }

        this._findReferencedEntities(obj, MappingModel.PropertyFlags.CascadeRefresh, (err, entities) => {
            if(err) return callback(err);
            this._refreshEntities(entities, callback);
        });
    }

    private _refreshEntities(entities: any[], callback: Callback): void {

        async.each(entities, (entity: any, done: (err?: Error) => void) => {
            var links = this._getObjectLinks(entity);
            if (!links || links.state != ObjectState.Managed) {
                return done(new PersistenceError("Object is not managed."));
            }

            // Refreshing an entity should not cause it to become dirty, so if we have an observer, destroy it before
            // refreshing the object.
            SessionImpl._stopWatching(links);

            links.persister.refresh(links.object, (err, document) => {
                if(err) return done(err);
                links.originalDocument = document;

                // clear dirty because object may have been dirty before refresh
                this._clearDirty(links);
                this._trackChanges(links);
                done();
            });
        }, callback);
    }

    private _flush(callback: Callback): void {

        // Call setImmediate to ensure that all Object.observe callbacks are handled before a flush
        setImmediate(() => {
            var head = this._scheduleHead;

            // clear list of scheduled objects
            this._scheduleHead = this._scheduleTail = null;

            if (this._traceEnabled) {
                var start = process.hrtime();
            }

            var batch = new Batch();
            this._buildBatch(batch, head, (err) => {
                if (err) return callback(err);

                batch.execute((err) => {
                    if (err) return callback(err);

                    if (start) {
                        var duration = getDuration(start);
                    }

                    this._batchCompleted(head, duration, callback);
                });
            });
        });
    }

    /**
     * Populates the batch with the current scheduled operations. Since building the batch could take a long time if
     * there are many scheduled operations, break it up into chucks so we are not blocking the Node event queue.
     * @param batch The batch to build
     * @param links The current link in the list of scheduled operations
     * @param callback Called when the batch has been built
     */
    private _buildBatch(batch: Batch, links: ObjectLinks, callback: Callback): void {

        var count = 0;

        while(links && count < 1000) {

            if (links.scheduledOperation == ScheduledOperation.DirtyCheck) {
                var document = links.persister.dirtyCheck(batch, links.object, links.originalDocument);
                if(document) {
                    // if we got a document back then the entity was dirty. change the scheduled operation to update
                    // so we know to run post-update callback when batch is finished
                    links.scheduledOperation = ScheduledOperation.Update;
                    links.originalDocument = document;
                }
            }
            else if (links.scheduledOperation == ScheduledOperation.Insert) {
                var document = links.persister.addInsert(batch, links.object);
                if(document) {
                    links.originalDocument = document;
                }
            }
            else if (links.scheduledOperation == ScheduledOperation.Delete) {
                links.persister.addRemove(batch, links.object);
            }

            if(batch.error) {
                return callback(batch.error);
            }

            links = links.next;
            count++;
        }

        // If there are more links in the queue, continue building the batch on the next tick.
        if(links) {
            process.nextTick(() => this._buildBatch(batch, links, callback));
        }
        else {
            // ok with not being async b/c calls to _buildBatch are always async
            callback();
        }
    }

    /**
     * Called after a batch is successfully executed.
     * @param head The head of the scheduled operation list.
     * @param duration The duration of the flush operation, for trace logging.
     * @param callback Called when processing is completed.
     */
    private _batchCompleted(head: ObjectLinks, duration: number, callback: Callback): void {

        if (this._traceEnabled) {
            this._logFlushStats(head, duration);
        }

        var links = head;
        while(links) {
            var next = links.next;

            links.scheduledOperation = ScheduledOperation.None;
            links.flags = ObjectFlags.None;
            // Remove links from list. No need to fix up links of prev/next because all items will be removed from the list.
            links.prev = links.next = null;

            switch(links.state) {
                case ObjectState.Removed:
                    // unlink any removed objects.
                    this._unlinkObject(links);
                    // then remove it's identifier
                    SessionImpl._clearIdentifier(links);
                    break;
                case ObjectState.Managed:
                    this._trackChanges(links);
                    break;
                default:
                    return callback(new PersistenceError("Unexpected object state in flush."));
            }

            links = next;
        }

        callback();
    }

    private _logFlushStats(head: ObjectLinks, duration: number): void {

        var inserted = 0, updated = 0, removed = 0, dirtyChecked = 0;

        var links = head;
        while (links) {

            switch (links.scheduledOperation) {
                case ScheduledOperation.Update:
                    updated++;
                    break;
                case ScheduledOperation.Delete:
                    inserted++;
                    break;
                case ScheduledOperation.Insert:
                    removed++;
                    break;
                case ScheduledOperation.DirtyCheck:
                    dirtyChecked++;
                    break;
            }

            links = links.next;
        }

        this.factory.logger.trace(
            {
                duration,
                operations: {
                    inserted,
                    updated,
                    removed,
                    dirtyChecked: dirtyChecked + updated
                }
            },
            `[Hydrate] Completed flush.`);
    }

    private _close(callback: Callback): void {

        this._queue.close();

        // flush and then clear the session
        this._flush((err) => {
            if(err) return callback(err);
            this._clear(callback);
        });
    }

    fetchInternal(obj: any, paths: string[], callback: ResultCallback<any>): void {

        if(obj == null) {
            return callback(null, obj);
        }

        if(Array.isArray(obj)) {
            async.map(obj, (item, done) => this.fetchInternal(item, paths, done), callback);
            return;
        }

        // TODO: handle set

        // TODO: when a reference is resolved do we update the referenced object? __proto__ issue.
        Reference.fetch(this, obj, (err, entity) => {
            if(err) return callback(err);

            this._fetchPaths(entity, paths, callback);
        });
    }

    private _fetchPaths(obj: any, paths: string[], callback: ResultCallback<any>): void {

        var links = this._getObjectLinks(obj);
        if (!links || links.state == ObjectState.Detached) {
            return callback(new PersistenceError("Object is not associated with the session."));
        }

        if(!paths || paths.length === 0) {
            process.nextTick(() => callback(null, obj));
        }
        else {
            var persister = links.persister;

            async.each(paths, (path: string, done: (err?: Error) => void) => {
                    persister.fetch(obj, path, done);
                },
                (err) => {
                    if (err) return callback(err);
                    callback(null, obj);
                });
        }
    }

    /**
     * Detaches all managed objects.
     * @param callback Callback to execute after operation completes.
     */
    private _clear(callback: Callback): void {

        for(var i = 0; i < this._objectLinks.length; i++) {
            var links = this._objectLinks[i];
            if(links) {
                // We call _cleanupUnlinkedObject instead of _unlinkObject because we clear the entire _objectLinks
                // list and _objectLinksById map so there is no need to remove the links individually.
                this._cleanupUnlinkedObject(links);
            }
        }

        // clear all object links
        this._objectLinksById = new Map();
        this._objectLinks = [];
        // clear scheduled operations
        this._scheduleHead = this._scheduleTail = null;

        process.nextTick(callback);
    }

    private _getObjectLinks(obj: any): ObjectLinks {

        var id = obj["id"];
        if (id) {
            var links = this._objectLinksById.get(id);
            if (!links || links.object !== obj) {
                // If we have an id but no links then the object must be detached since we assume that we manage
                // the assignment of the identifier.
                // Also, we the id is linked but the object in the session is different than the object passed in
                // then we also have a detached object.
                return cachedDetachedLinks;
            }
            return links;
        }
    }

    private _linkObject(obj: any, persister: Persister): ObjectLinks {

        var id = obj["id"];
        if(id == null) {
            throw new PersistenceError("Object is missing identifier.");
        }

        if(this._objectLinksById.has(id)) {
            throw new PersistenceError("Session already contains an entity with identifier '" + id + "'.");
        }

        var links = {
            state: ObjectState.Managed,
            flags: ObjectFlags.None,
            object: obj,
            persister: persister,
            index: this._objectLinks.length
        };

        this._objectLinksById.set(id, links);
        this._objectLinks.push(links);
        return links;
    }

    private _unlinkObject(links: ObjectLinks): void {

        this._objectLinksById.delete(links.object["id"]);
        this._objectLinks[links.index] = undefined;

        this._cleanupUnlinkedObject(links);
    }

    private _cleanupUnlinkedObject(links: ObjectLinks): void {

        SessionImpl._stopWatching(links);
        // if the object was never persisted, then clear it's identifier as well
        if (links.scheduledOperation == ScheduledOperation.Insert) {
            SessionImpl._clearIdentifier(links);
        }
    }

    private _scheduleOperation(links: ObjectLinks, operation: ScheduledOperation): void {

        // TODO: maintain a count of scheduled operations by Root Mapping so query operations know if a flush is needed before query

        if(!links.scheduledOperation) {
            if(this._scheduleHead) {
                // add operation to the end of the schedule
                this._scheduleTail.next = links;
                links.prev = this._scheduleTail;
                this._scheduleTail = links;
            }
            else {
                // this is the first scheduled operation so initialize the schedule
                this._scheduleHead = this._scheduleTail = links;
            }
        }

        links.scheduledOperation = operation;
    }

    private _clearScheduledOperation(links: ObjectLinks): void {

        if(!links.scheduledOperation) {
            return;
        }

        // remove links from the schedule
        if(links.prev) {
            links.prev.next = links.next;
        }
        else {
            this._scheduleHead = links.next;
        }

        if(links.next) {
            links.next.prev = links.prev;
        }
        else {
            this._scheduleTail = links.prev;
        }

        links.scheduledOperation = ScheduledOperation.None;
    }

    private static _clearIdentifier(links: ObjectLinks): void {

        links.object["_id"] = links.object["id"] = undefined;
    }

    private _findReferencedEntities(obj: any, flags: MappingModel.PropertyFlags, callback: ResultCallback<any[]>): void {

        var mapping = this.factory.getMappingForObject(obj);
        if (!mapping) {
            callback(new PersistenceError("Object type is not mapped as an entity."));
            return;
        }

        var entities: any[] = [],
            embedded: any[] = [];

        this._walk(mapping, obj, flags, entities, embedded, err => {
            if (err) return callback(err);
            process.nextTick(() => callback(null, entities));
        });
    }

    private _walk(mapping: EntityMapping, entity: any, flags: MappingModel.PropertyFlags,  entities: any[], embedded: any[], callback: Callback): void {

        var references: Reference[] = [];
        mapping.walk(this, entity, flags | MappingModel.PropertyFlags.WalkEntities, entities, embedded, references);

        async.each(references, (reference: Reference, done: (err?: Error) => void) => {

            reference.fetch(this, (err: Error, entity: any) => {
                if (err) return done(err);
                this._walk(reference.mapping, entity, flags, entities, embedded, done);
            });
        }, callback);
    }

    private _createTaskQueue(): void {

        if (this._queue) {
            this._queue.removeAllListeners();
        }

        this._queue = new TaskQueue((action, args, callback) => this._execute(action, args, callback));

        // if we get an error on the queue, raise it on the session
        this._queue.on('error', (err: Error) => {
            this.emit('error', err);
        });
    }
}

