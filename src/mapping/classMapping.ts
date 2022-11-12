import {ObjectMapping} from "./objectMapping";
import {MappingRegistry} from "./mappingRegistry";
import {Reference} from "../reference";
import {MappingModel} from "./mappingModel";
import {InternalSession} from "../session";
import {ResultCallback} from "..";
import {ReadContext} from "./readContext";
import {WriteContext} from "./writeContext";
import {PersistenceError} from "../persistenceError";

var OriginalDocument = Symbol();

/**
 * @hidden
 */
export class ClassMapping extends ObjectMapping {

    private readonly _baseClass: ClassMapping;
    private _subclasses: ClassMapping[];
    private _discriminatorMap: Map<string, ClassMapping>;
    private _registry: MappingRegistry;

    inheritanceRoot: ClassMapping;

    name: string;
    discriminatorField: string;
    classConstructor: Function;

    /**
     * Constructs a ClassMapping.
     * @param baseClass The baseclass mapping for this class. If no baseclass is specified then it is assumed that this
     * mapping represents the inheritance root.
     */
    constructor(baseClass?: ClassMapping) {
        super();

        this.flags |= MappingModel.MappingFlags.Class;

        this._baseClass = baseClass;
        if(!baseClass) {
            this.flags |= MappingModel.MappingFlags.InheritanceRoot;
            this.inheritanceRoot = this;
        }
        else {
            var previous = baseClass;
            while(baseClass) {
                baseClass._addSubClass(this);
                previous = baseClass;
                baseClass = baseClass._baseClass;
            }
            this.inheritanceRoot = previous;
        }
    }

    private _discriminatorValue: string;

    get discriminatorValue(): string {
        return this._discriminatorValue;
    }


    setDiscriminatorValue(value: string): void {

        if(typeof value !== "string") {
            throw new PersistenceError("Expected string for discriminator value.");
        }
        this._discriminatorValue = value;
        this._addDiscriminatorMapping(value, this);
    }

    setQueryDocumentDiscriminator(obj: any): void {

        var discriminators: string[];

        // there is no need to include the discriminator for queries on the inheritance root since everything is included.
        if ((this.flags & MappingModel.MappingFlags.InheritanceRoot) == 0) {
            discriminators = [];
            this._getDescendantDiscriminators(discriminators);
        }

        if (!discriminators || discriminators.length == 0) {
            this.setQueryDocumentDiscriminator = <any>(function() { /*noop*/ });
            return;
        }

        var discriminator: any;

        if(discriminators.length == 1) {
            discriminator = discriminators[0];
        }
        else {
            discriminator = {
                '$in': discriminators
            }
        }

        obj[this.inheritanceRoot.discriminatorField] = discriminator;

        // TODO: escape discriminatorField
        this.setQueryDocumentDiscriminator = <any>(new Function("o", "o['" + this.inheritanceRoot.discriminatorField + "'] = " + JSON.stringify(discriminator)));
    }

    setDocumentDiscriminator(obj: any): void {

        if(this._discriminatorValue === undefined) {
            this.setDocumentDiscriminator = <any>(function() { /*noop*/ });
            return;
        }

        // TODO: escape discriminatorField and discriminatorValue
        this.setDocumentDiscriminator = <any>(new Function("o", "o['" + this.inheritanceRoot.discriminatorField + "'] = \"" + this._discriminatorValue + "\""));
        obj[this.inheritanceRoot.discriminatorField] = this._discriminatorValue;
    }

    getDocumentDiscriminator(obj: any): string {

        // TODO: escape discriminatorField
        this.getDocumentDiscriminator = <any>(new Function("o", "return o['" + this.inheritanceRoot.discriminatorField + "']"));
        return obj[this.inheritanceRoot.discriminatorField]
    }

    private _getDescendantDiscriminators(discriminators: string[]): void {

        if (this._discriminatorValue) {
            discriminators.push(this._discriminatorValue);
        }

        var subclasses = this._subclasses;
        if (subclasses) {
            for (var i = 0; i < subclasses.length; i++) {
                var discriminatorValue = subclasses[i]._discriminatorValue;
                if(discriminatorValue) {
                    discriminators.push(discriminatorValue);
                }
            }
        }
    }

    get hasSubClasses(): boolean {
        return this._subclasses && this._subclasses.length > 0;
    }

    get hasBaseClass(): boolean {
        return this._baseClass !== undefined;
    }

    private _addSubClass(subclass: ClassMapping): void {

        if(!this._subclasses) {
            this._subclasses = [];
        }
        this._subclasses.push(subclass);
    }

    private _addDiscriminatorMapping(value: string, mapping: ClassMapping): void {

        if(!this._discriminatorMap) {
            this._discriminatorMap = new Map();
        }

        if(this._discriminatorMap.has(value)) {
            throw new PersistenceError("There is already a class in this inheritance hierarchy with a discriminator value of '" + value + "'.");
        }

        this._discriminatorMap.set(value, mapping);

        if (this._baseClass) {
            this._baseClass._addDiscriminatorMapping(value, mapping);
        }
    }

    private _ensureRegistry(): MappingRegistry {

        if(!this._registry) {
            this._registry = new MappingRegistry();
            // add this mapping to the registry then add subclasses
            this._registry.addMapping(this);
            if(this._subclasses) {
                var subclasses = this._subclasses;
                for (var i = 0, l = subclasses.length; i < l; i++) {
                    this._registry.addMapping(subclasses[i]);
                }
            }
        }

        return this._registry;
    }

    read(context: ReadContext, value: any): any {

        if(value == null) return null;

        var mapping = this.getMapping(context, value);
        if (mapping) {
            return mapping.readClass(context, value);
        }
    }

    /**
     * Gets the mapping for the specified document. Note that this method can only be called on an inheritance root.
     */
    getMapping(context: ReadContext, document: any): ClassMapping {

        var mapping = this._getMappingForDocument(document);
        if(mapping === undefined) {
            context.addError(`Unknown discriminator value '${this.getDocumentDiscriminator(document)}' for class '${this.name}'.`);
            return;
        }

        return mapping;
    }

    private _getMappingForDocument(document: any): ClassMapping {

        var discriminatorValue = this.getDocumentDiscriminator(document);
        if (discriminatorValue === undefined) {
            return this;
        }

        if (this._discriminatorMap) {
            return this._discriminatorMap.get(discriminatorValue);
        }
    }

    protected readClass(context: ReadContext, value: any): any {

        var obj = this.readObject(context, Object.create(this.classConstructor.prototype), value, /*checkRemoved*/ false);

        // save original document value for immutable embeddable
        if ((this.flags & MappingModel.MappingFlags.ImmutableEmbeddable) == MappingModel.MappingFlags.ImmutableEmbeddable) {
            obj[OriginalDocument] = value;
        }

        return obj;
    }

    write(context: WriteContext, value: any): any {

        if(value == null) return null;

        // return original document for immutable embeddable
        var originalDocument = value[OriginalDocument];
        if (originalDocument != null) {
            return originalDocument;
        }

        // Object may be a subclass of the class whose type was passed, so retrieve mapping for the object. If it
        // does not exist, default to current mapping.
        var mapping = this._ensureRegistry().getMappingForObject(value);
        return (mapping || this).writeClass(context, value, !!mapping);
    }

    protected writeClass(context: WriteContext, value: any, mappedConstructor: boolean): any {

        var document: any = {};

        // If the constructor is not mapped then we should be writing a query document
        if(mappedConstructor) {
            this.setDocumentDiscriminator(document);
        }
        else {
            this.setQueryDocumentDiscriminator(document);
        }

        return this.writeObject(context, document, value);
    }

    areEqual(documentValue1: any, documentValue2: any): boolean {

        if(documentValue1 === documentValue2) return true;
        if(documentValue1 == null || documentValue2 == null) return false;

        var mapping1 = this._getMappingForDocument(documentValue1);
        var mapping2 = this._getMappingForDocument(documentValue2);

        // make sure both documents have the same mapping
        if(mapping1 === undefined || mapping2 === undefined || mapping1 !== mapping2) {
            return false;
        }

        return mapping1._areEqual(documentValue1, documentValue2);
    }

    private _areEqual(documentValue1: any, documentValue2: any): boolean {

        return super.areEqual(documentValue1, documentValue2);
    }

    walk(session: InternalSession, value: any, flags: MappingModel.PropertyFlags, entities: any[], embedded: any[], references: Reference[]): void {

        if (!value || typeof value !== "object") return;

        return (this._ensureRegistry().getMappingForObject(value) || this)._walk(session, value, flags, entities, embedded, references);
    }

    private _walk(session: InternalSession, value: any, flags: MappingModel.PropertyFlags, entities: any[], embedded: any[], references: Reference[]): void {
        super.walk(session, value, flags, entities, embedded, references);
    }

    fetch(session: InternalSession, parentEntity: any, value: any, path: string[], depth: number, callback: ResultCallback<any>): void {
        if (!value || typeof value !== "object") {
            process.nextTick(() => callback(null, value));
            return;
        }

        return (this._ensureRegistry().getMappingForObject(value) || this)._fetch(session, parentEntity, value, path, depth, callback);
    }

    private _fetch(session: InternalSession, parentEntity: any, value: any, path: string[], depth: number, callback: ResultCallback<any>): void {
        super.fetch(session, parentEntity, value, path, depth, callback);
    }

}
