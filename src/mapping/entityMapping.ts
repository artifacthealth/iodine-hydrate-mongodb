import {IdentityGenerator} from "..";
import {ClassMapping} from "./classMapping";
import {ChangeTrackingType, FlushPriority} from "./mappingModel";
import {Index} from "./index";
import {CollectionOptions} from "./collectionOptions";
import {MappingModel} from "./mappingModel";
import {Reference} from "../reference";
import {InternalSession} from "../session";
import {ResultCallback} from "..";
import {ResolveContext} from "./resolveContext";
import {ReadContext} from "./readContext";
import {Observer} from "../observer";
import {Property} from "./property";
import {WriteContext} from "./writeContext";
import {PersistenceError} from "../persistenceError";
import {QueryDocument} from "..";

/**
 * @hidden
 */
export class EntityMapping extends ClassMapping {

    collectionName: string;
    databaseName: string;
    indexes: Index[];
    collectionOptions: CollectionOptions;

    identity: IdentityGenerator;

    changeTracking: ChangeTrackingType;

    versioned: boolean;
    versionField: string;

    /**
     * The order in which collections are flushed to the database. Higher priority collections are flushed first.
     */
    flushPriority = FlushPriority.Medium;

    private _defaultFields: QueryDocument;

    constructor(baseClass?: EntityMapping) {
        super(baseClass);

        this.flags &= ~MappingModel.MappingFlags.Embeddable;
        this.flags |= MappingModel.MappingFlags.Entity;
    }

    /**
     * Validates a property before adding it to the mapping. Returns any validation error messages or undefined if none.
     * @param property The property to validate.
     * @returns The error message.
     */
    validateProperty(property: Property): string {

        if (property && property.name) {

            if (property.name == "_id") {
                return "The '_id' property on an entity class is automatically populated with the primary key and cannot be explicitly mapped.";
            }

            if (property.name == "id") {
                return "The 'id' property on an entity class is automatically populated with the string representation of the primary key " +
                    "and cannot be explicitly mapped.";
            }
        }

        return super.validateProperty(property);
    }

    setDocumentVersion(obj: any, version: number): void {

        // TODO: escape versionField
        this.setDocumentVersion = <any>(new Function("o", "v", "o['" + (<EntityMapping>this.inheritanceRoot).versionField + "'] = v"));
        obj[(<EntityMapping>this.inheritanceRoot).versionField] = version;
    }

    getDocumentVersion(obj: any): number {

        // TODO: escape versionField
        this.getDocumentVersion = <any>(new Function("o", "return o['" + (<EntityMapping>this.inheritanceRoot).versionField + "']"));
        return obj[(<EntityMapping>this.inheritanceRoot).versionField]
    }

    addIndex(index: Index): void {

        if(!this.indexes) {
            this.indexes = [];
        }
        this.indexes.push(index);
    }

    refresh(context: ReadContext, entity: any, document: any): any {

        var mapping = this.getMapping(context, document);
        if (mapping) {
            if(mapping != this) {
                // http://jsperf.com/change-proto-on-class
                // http://stackoverflow.com/questions/23807805/why-is-mutating-the-prototype-of-an-object-bad-for-performance
                context.addError("Refresh does not support changing instantiated class of entity.");
                return;
            }
            return this.readObject(context, entity, document, /* checkRemoved */ true);
        }
    }

    read(context: ReadContext, value: any): any {

        if(value == null) return null;

        var id: any;

        // if this is not the top level, the value should be the id
        if(context.path) {
            // TODO: handle DBRef
            id = value;
        }
        else {
            // otherwise, get the value from the document
            id = value["_id"];
            if (!id) {
                context.addError("Missing identifier.", "_id");
                return;
            }
        }

        // TODO: handle DBRef
        if(!(<EntityMapping>this.inheritanceRoot).identity.validate(id)) {
            context.addError("'" + id.toString() + "' is not a valid identifier.", (context.path ? context.path + "." : "") + "_id");
            return;
        }

        // if this is not the top level
        if(context.path) {
            // TODO: confirm how we want to handle ObjectState.Removed.
            return context.session.getReferenceInternal(this, id);
        }

        var obj = super.read(context, value);
        if (obj) {
            obj["_id"] = id;
            obj["id"] = id.toString();
        }
        return obj;
    }

    write(context: WriteContext, value: any): any {

        if(value == null) return null;

        var id: any;

        // Note that this.classConstructor could represent a base class since we are checking the id before looking up
        // the mapping for the current object in Class.write.
        // TODO: validate mapping that all classes inherit from inheritanceRoot or this ^ may not work
        // if the value is not an instance of the entity's constructor then it should be an identifier or DBRef

        // TODO: Use session.getId?
        // retrieve the id from the object
        if(!(id = value["_id"])) {
            context.addError("Missing identifier.", (context.path ? context.path + "." : "") + "_id");
            return;
        }

        if(!(<EntityMapping>this.inheritanceRoot).identity.validate(id)) {
            context.addError("'" + id.toString() + "' is not a valid identifier.", (context.path ? context.path + "." : "") + "_id");
            return;
        }

        // if this is not the top level then just return a reference
        if(context.path) {
            // TODO: decide when to save reference as a DBRef
            return id;
        }

        var document = super.write(context, value);
        if(document) {
            document["_id"] = id;
        }
        return document;
    }

    watchEntity(entity: any, observer: Observer): void {

        super.watch(entity, observer, []);
    }

    watch(value: any, observer: Observer, visited: any[]): void {

        // Do nothing. Watch does not propagate to other entities.
    }

    areDocumentsEqual(document1: any, document2: any): boolean {

        return super.areEqual(document1, document2);
    }

    areEqual(documentValue1: any, documentValue2: any): boolean {

        if(documentValue1 === documentValue2) return true;
        if(documentValue1 == null || documentValue2 == null) return false;

        var id1 = documentValue1["_id"] || documentValue1,
            id2 = documentValue2["_id"] || documentValue2;

        if(id1 == null || id2 == null) {
            return false;
        }

        return (<EntityMapping>this.inheritanceRoot).identity.areEqual(id1, id2)
    }

    walk(session: InternalSession, value: any, flags: MappingModel.PropertyFlags, entities: any[], embedded: any[], references: Reference[]): void {

        if (!value || typeof value !== "object") return;

        if(Reference.isReference(value)) {
            // TODO: handle DBRef
            var entity = session.getObject((<Reference>value).id);
            if (entity) {
                value = entity;
            }
            else {
                if(flags & MappingModel.PropertyFlags.Dereference) {
                    // store reference to resolve later
                    references.push(value);
                }
                return;
            }
        }

        if (entities.indexOf(value) !== -1) return;
        entities.push(value);

        // If this isn't the first entity, only continue if we have the WalkEntities flag
        if((flags & MappingModel.PropertyFlags.WalkEntities) == 0 && entities.length > 1) return;

        super.walk(session, value, flags, entities, embedded, references);
    }

    fetch(session: InternalSession, parentEntity: any, value: any, path: string[], depth: number, callback: ResultCallback<any>): void {

        if (!value || typeof value !== "object") {
            process.nextTick(() => callback(null, value));
            return;
        }

        if(Reference.isReference(value)) {
            // TODO: handle DBRef
            // We don't bother with the call to getObject here since fetch will call getObject. The reason we have the
            // separate call to getObject in 'walk' above is that walk only calls fetch if ProperFlags.Dereference is
            // passed in but should still include the object in the found entities if the object is managed.
            (<Reference>value).fetch(session, (err, entity) => {
                if(err) return callback(err);
                super.fetch(session, entity, entity, path, depth, callback);
            });
            return;
        }

        super.fetch(session, value, value, path, depth, callback);
    }

    fetchInverse(session: InternalSession, parentEntity: any, propertyName: string, path: string[], depth: number, callback: ResultCallback<any>): void {

        if(!parentEntity) {
            return callback(new PersistenceError("Parent entity required to resolve inverse relationship."));
        }

        session.getPersister(this).findOneInverseOf(parentEntity, propertyName, (err, value) => {
            if(err) return callback(err);
            super.fetch(session, this, value, path, depth, callback);
        });
    }

    protected fetchPropertyValue(session: InternalSession, value: any, property: Property, callback: ResultCallback<any>): void {

        session.getPersister(this).fetchPropertyValue(value, property, callback);
    }

    getDefaultFields(): QueryDocument {

        var fields: QueryDocument = {};

        if (this._defaultFields === undefined) {
            // find any lazy fields and mark them with a 0 so they are not loaded
            for (var i = 0; i < this.properties.length; i++) {
                var property = this.properties[i];
                if ((property.flags & MappingModel.PropertyFlags.FetchLazy) != 0) {
                    property.setFieldValue(fields, 0);
                }
            }

            this._defaultFields = fields;
        }

        return this._defaultFields;
    }

    protected resolveCore(context: ResolveContext): void {

        if(!context.isFirst) {
            context.setError("Unable to resolve entity mapping. The dot notation can only be used for embedded objects.");
            return;
        }

        super.resolveCore(context);
    }
}
